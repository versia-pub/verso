/**
 * Statuses, local or remote: posting and editing them, who may see them, and deleting them.
 * @module
 */
import { type AccountRow, findAccount } from "../accounts/account_queries.ts";
import { countNote } from "../accounts/count_queries.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { userUri } from "../accounts/render.ts";
import type { TextFormat, Visibility } from "../accounts/tables.ts";
import { setNoteEmojis, usableEmojiIds } from "../emojis/emoji_queries.ts";
import { fetchBudget } from "../federation/resolver.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type Found, type Mention, renderText, scanText } from "../kernel/markup.ts";
import {
    attach,
    attachedTo,
    type AttachmentChange,
    changesAttachments,
    reattach,
} from "../media/attachments.ts";
import type { NoteEdited, NotePosted } from "./events.ts";
import {
    countReply,
    findNote,
    insertNote,
    keepVersion,
    type NoteRow,
    updateNote,
} from "./note_queries.ts";
import { countShare } from "./share_queries.ts";
import { visibleOriginal } from "./visibility.ts";

/**
 * Counts a status that its author posted, or uncounts one they deleted, as Mastodon does. A direct
 * status isn't counted, and only a public or unlisted status is counted as a reply, so the counts
 * don't reveal statuses that others can't see. A boost is counted as the author's status, and as a
 * boost of the status it boosts.
 */
export const countPosted = async (
    ctx: Context,
    note: Pick<
        NoteRow,
        "account_id" | "visibility" | "created_at" | "in_reply_to_id" | "reblog_of_id"
    >,
    by: 1 | -1,
): Promise<void> => {
    if (note.visibility !== "direct") await countNote(ctx, note.account_id, by, note.created_at);

    const listed = note.visibility === "public" || note.visibility === "unlisted";
    if (listed && note.in_reply_to_id !== null) await countReply(ctx, note.in_reply_to_id, by);
    if (note.reblog_of_id !== null) await countShare(ctx, note.reblog_of_id, by);
};

/**
 * What a local user posts. Without a visibility, sensitivity or language, the user's defaults
 * apply.
 */
export type Draft = {
    readonly text: string;
    readonly format: TextFormat;
    /** Empty for none. A status with a content warning is sensitive. */
    readonly spoilerText: string;
    readonly visibility?: Visibility;
    readonly sensitive?: boolean;
    readonly language?: string;
    /** The status it replies to, which its author must be able to see. */
    readonly inReplyToId?: string;
    /** The uploads attached to it, in order, which {@link attach} validates. */
    readonly mediaIds?: readonly string[];
};

const mentionKey = (mention: Mention) => `${mention.username}@${mention.domain}`.toLowerCase();

/** How long posting may spend looking up the users it mentions. */
const mentionsMs = 15_000;

/**
 * The accounts that `mentions` refer to, by {@link mentionKey}, fetching remote users if Verso
 * doesn't have them, from one shared budget, so a post can't make Verso fetch without end. Mentions
 * of nonexistent accounts are dropped, and so are those beyond the number of accounts the settings
 * allow.
 */
const mentioned = async (ctx: Context, mentions: readonly Mention[]) => {
    const budget = fetchBudget(20, ctx.clock.now().getTime() + mentionsMs);
    const accounts = new Map<string, AccountRow>();

    for (const mention of mentions) {
        const key = mentionKey(mention);
        if (accounts.has(key)) continue;
        if (accounts.size >= ctx.settings.mentions) break;

        const { username, domain } = mention;
        const address = parseAddress(ctx, domain === null ? username : `${username}@${domain}`);
        const row = address && await findAccountByAddress(ctx, address, { fetch: true, budget });
        if (row) accounts.set(key, row);
    }

    return accounts;
};

/** A local user's text as HTML, linking the mentions of `accounts`, found by {@link mentioned}. */
const renderDraft = (
    ctx: Context,
    text: string,
    format: TextFormat,
    accounts: ReadonlyMap<string, AccountRow>,
) => renderText(text, format, {
    mention: (mention) => {
        const row = accounts.get(mentionKey(mention));
        return row && userUri(ctx, row);
    },
    hashtag: (tag) => ctx.urls.url`/tags/${tag.toLowerCase()}`,
});

/**
 * Links the custom emojis named in a local status's text and content warning, as `found`, that its
 * author may use, replacing the ones it linked before.
 */
const useEmojis = async (ctx: Context, note: NoteRow, found: Found, spoilerText: string) => {
    const shortcodes = new Set([
        ...found.shortcodes,
        ...scanText(spoilerText, "text/plain").shortcodes,
    ]);
    await setNoteEmojis(ctx, note.id, await usableEmojiIds(ctx, note.account_id, [...shortcodes]));
};

/**
 * Posts a status by `accountId`, a local user, and counts it. The mentioned users are looked up
 * first, outside the transaction, as that can mean fetching from remote instances. Returns
 * `undefined` if the status it replies to doesn't exist or `accountId` may not see it.
 */
export const postNote = async (
    ctx: Context,
    accountId: string,
    draft: Draft,
): Promise<NoteRow | undefined> => {
    const found = scanText(draft.text, draft.format);
    const accounts = await mentioned(ctx, found.mentions);

    return await ctx.transaction(async (tx) => {
        const author = await findAccount(tx, accountId);
        if (author === undefined) throw new Error(`Account ${accountId} doesn't exist`);

        const replyTo = draft.inReplyToId;
        const parent = replyTo === undefined
            ? undefined
            : await visibleOriginal(tx, replyTo, accountId);
        if (replyTo !== undefined && parent === undefined) return undefined;

        const html = renderDraft(tx, draft.text, draft.format, accounts);
        const note = await insertNote(
            tx,
            {
                id: tx.ids(),
                account_id: accountId,
                instance_id: null,
                remote_id: null,
                visibility: draft.visibility ?? author.default_visibility,
                content: draft.text,
                content_format: draft.format,
                content_html: html,
                spoiler_text: draft.spoilerText,
                sensitive: draft.spoilerText !== "" ||
                    (draft.sensitive ?? author.default_sensitive),
                language: draft.language ?? (author.default_language || null),
                in_reply_to_id: parent?.id ?? null,
                in_reply_to_account_id: parent?.account_id ?? null,
                created_at: tx.clock.now(),
                edited_at: null,
            },
            [...accounts.values()].map((row) => row.id),
            found.hashtags,
        );
        await useEmojis(tx, note, found, draft.spoilerText);
        await attach(tx, accountId, note.id, draft.mediaIds ?? []);

        await countPosted(tx, note, 1);

        const event: NotePosted = { type: "notes.posted", noteId: note.id };
        await emit(tx, event);

        return note;
    });
};

/** What a local user changes in a status. Omitted fields stay as they were. */
export type Edit = {
    readonly text: string;
    readonly format?: TextFormat;
    /** Empty for none. A status with a content warning is sensitive. */
    readonly spoilerText?: string;
    readonly sensitive?: boolean;
    readonly language?: string;
    /**
     * The uploads to attach in place of its current media, in order, which {@link attach}
     * validates.
     */
    readonly mediaIds?: readonly string[];
    /** Changes to the descriptions of the media attached after the edit. */
    readonly mediaChanges?: readonly AttachmentChange[];
};

/**
 * Edits a status written by `accountId`, a local user, and looks up the mentioned users again, as
 * posting does. The previous version is saved in its edit history. Returns the status as it is now,
 * or `undefined` if it isn't theirs or is a boost, which has nothing to edit. A status left
 * unchanged isn't marked as edited or sent again.
 */
export const editNote = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    edit: Edit,
): Promise<NoteRow | undefined> => {
    const before = await findNote(ctx, noteId);
    if (before?.account_id !== accountId || before.reblog_of_id !== null) return undefined;

    const format = edit.format ?? before.content_format;
    const found = scanText(edit.text, format);
    const accounts = await mentioned(ctx, found.mentions);

    return await ctx.transaction(async (tx) => {
        // Unless it was deleted in the meantime.
        const note = await findNote(tx, noteId);
        if (note === undefined) return undefined;

        const spoilerText = edit.spoilerText ?? note.spoiler_text;
        const changes = {
            content: edit.text,
            content_format: format,
            spoiler_text: spoilerText,
            // As on Mastodon, a content warning sent without an explicit sensitivity makes the
            // status sensitive.
            sensitive: spoilerText !== "" ||
                (edit.sensitive ?? (edit.spoilerText === undefined && note.sensitive)),
            language: edit.language ?? note.language,
        };
        const media = await attachedTo(tx, note.id);
        const mediaChanges = edit.mediaChanges ?? [];
        const same = changes.content === note.content &&
            changes.content_format === note.content_format &&
            changes.spoiler_text === note.spoiler_text && changes.sensitive === note.sensitive &&
            changes.language === note.language &&
            !changesAttachments(media, edit.mediaIds, mediaChanges);
        if (same) return note;

        await keepVersion(tx, note);
        await updateNote(
            tx,
            note.id,
            {
                ...changes,
                content_html: renderDraft(tx, edit.text, format, accounts),
                edited_at: tx.clock.now(),
            },
            [...accounts.values()].map((row) => row.id),
            found.hashtags,
        );
        await useEmojis(tx, note, found, spoilerText);
        await reattach(tx, accountId, note.id, edit.mediaIds, mediaChanges);

        const event: NoteEdited = { type: "notes.edited", noteId: note.id };
        await emit(tx, event);

        return await findNote(tx, note.id);
    });
};
