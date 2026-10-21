/**
 * Notes, on this instance or another: posting and editing them, who may see them, and deleting them.
 * @module
 */
import { type AccountRow, findAccount } from "../accounts/account_queries.ts";
import { countNote } from "../accounts/count_queries.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { userUri } from "../accounts/render.ts";
import { isAccountDeleting } from "../accounts/events.ts";
import type { TextFormat, Visibility } from "../accounts/tables.ts";
import { fetchBudget } from "../federation/resolver.ts";
import { isFollowing } from "../graph/follows.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type Mention, renderText, scanText } from "../kernel/markup.ts";
import type { NoteDeleted, NoteEdited, NotePosted } from "./events.ts";
import {
    countReply,
    deleteNote,
    findNote,
    insertNote,
    keepVersion,
    mentions,
    mentionsOf,
    type NoteRow,
    uncountRepliesBy,
    updateNote,
} from "./note_queries.ts";

/**
 * Whether `viewerId`, or anyone if it is `null`, may see `note`. Public and unlisted notes are for
 * anyone, private ones for the author's followers, and direct ones for those they mention, who
 * may always see a note, as may its author.
 */
export const canSee = async (
    ctx: Context,
    note: NoteRow,
    viewerId: string | null,
): Promise<boolean> => {
    if (note.visibility === "public" || note.visibility === "unlisted") return true;
    if (viewerId === null) return false;
    if (viewerId === note.account_id || await mentions(ctx, note.id, viewerId)) return true;

    return note.visibility === "private" && await isFollowing(ctx, viewerId, note.account_id);
};

/**
 * The visibilities of an account's notes that `viewerId`, or anyone if it is `null`, sees among
 * them: all of them for the account itself, private ones too for its followers, and otherwise
 * public and unlisted ones. Direct notes that mention the viewer aren't among them, as on Mastodon.
 */
export const visibilitiesFor = async (
    ctx: Context,
    accountId: string,
    viewerId: string | null,
): Promise<Visibility[]> => {
    if (viewerId === accountId) return ["public", "unlisted", "private", "direct"];
    if (viewerId !== null && await isFollowing(ctx, viewerId, accountId)) {
        return ["public", "unlisted", "private"];
    }

    return ["public", "unlisted"];
};

/** The note with this id, if there is one and `viewerId` may see it. */
export const visibleNote = async (
    ctx: Context,
    id: string,
    viewerId: string | null,
): Promise<NoteRow | undefined> => {
    const note = await findNote(ctx, id);
    return note && await canSee(ctx, note, viewerId) ? note : undefined;
};

/**
 * Counts a note its author posted, or deleted, as Mastodon does: a direct note isn't counted, and
 * only a public or unlisted one as a reply, so the counts don't tell of notes others can't see.
 */
export const countPosted = async (
    ctx: Context,
    note: Pick<NoteRow, "account_id" | "visibility" | "created_at" | "in_reply_to_id">,
    by: 1 | -1,
): Promise<void> => {
    if (note.visibility !== "direct") await countNote(ctx, note.account_id, by, note.created_at);

    const listed = note.visibility === "public" || note.visibility === "unlisted";
    if (listed && note.in_reply_to_id !== null) await countReply(ctx, note.in_reply_to_id, by);
};

/** Deletes a note, uncounting it. Returns whether there was one. */
export const removeNote = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        // Read while they are there: the event says who could see the note, so they can be told.
        const mentionIds = (await mentionsOf(tx, [id])).get(id) ?? [];
        const note = await deleteNote(tx, id);
        if (note === undefined) return false;

        await countPosted(tx, note, -1);

        const event: NoteDeleted = {
            type: "notes.deleted",
            noteId: note.id,
            accountId: note.account_id,
            visibility: note.visibility,
            mentionIds,
            inReplyToAccountId: note.in_reply_to_account_id,
        };
        await emit(tx, event);

        return true;
    });

/** What a local user posts. Without a visibility, sensitivity or language, it has their defaults. */
export type Draft = {
    readonly text: string;
    readonly format: TextFormat;
    /** Empty for none. A note with one is sensitive. */
    readonly spoilerText: string;
    readonly visibility?: Visibility;
    readonly sensitive?: boolean;
    readonly language?: string;
    /** The note it replies to, which its author must be able to see. */
    readonly inReplyToId?: string;
};

const mentionKey = (mention: Mention) => `${mention.username}@${mention.domain}`.toLowerCase();

/** How long posting may spend finding the users it mentions. */
const mentionsMs = 15_000;

/**
 * The accounts `mentions` are of, by {@link mentionKey}, with other instances' users fetched if
 * Verso doesn't have them, from one budget, so a post can't make Verso fetch without end. Mentions
 * of no one are left out.
 */
const mentioned = async (ctx: Context, mentions: readonly Mention[]) => {
    const budget = fetchBudget(20, ctx.clock.now().getTime() + mentionsMs);
    const accounts = new Map<string, AccountRow>();

    for (const mention of mentions) {
        const key = mentionKey(mention);
        if (accounts.has(key)) continue;

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
 * Posts a note by `accountId`, a local user, and counts it. Who it mentions is found first, outside
 * the transaction, as that can mean asking other instances. Returns `undefined` if the note it
 * replies to isn't there, or its author may not see it.
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
            : await visibleNote(tx, replyTo, accountId);
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

        await countPosted(tx, note, 1);

        const event: NotePosted = { type: "notes.posted", noteId: note.id };
        await emit(tx, event);

        return note;
    });
};

/** What a local user changes in a note. What is left out stays as it was. */
export type Edit = {
    readonly text: string;
    readonly format?: TextFormat;
    /** Empty for none. A note with one is sensitive. */
    readonly spoilerText?: string;
    readonly sensitive?: boolean;
    readonly language?: string;
};

/**
 * Edits a note `accountId`, a local user, wrote, finding who it mentions again, as posting does.
 * What it said before is kept for its history. Returns the note as it is now, or `undefined` if it
 * isn't theirs. A note left as it was isn't marked edited, or sent again.
 */
export const editNote = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    edit: Edit,
): Promise<NoteRow | undefined> => {
    const before = await findNote(ctx, noteId);
    if (before?.account_id !== accountId) return undefined;

    const format = edit.format ?? before.content_format;
    const found = scanText(edit.text, format);
    const accounts = await mentioned(ctx, found.mentions);

    return await ctx.transaction(async (tx) => {
        // Unless it was deleted meanwhile.
        const note = await findNote(tx, noteId);
        if (note === undefined) return undefined;

        const spoilerText = edit.spoilerText ?? note.spoiler_text;
        const changes = {
            content: edit.text,
            content_format: format,
            spoiler_text: spoilerText,
            // As on Mastodon, a warning given without a word on sensitivity decides it.
            sensitive: spoilerText !== "" ||
                (edit.sensitive ?? (edit.spoilerText === undefined && note.sensitive)),
            language: edit.language ?? note.language,
        };
        const same = changes.content === note.content &&
            changes.content_format === note.content_format &&
            changes.spoiler_text === note.spoiler_text && changes.sensitive === note.sensitive &&
            changes.language === note.language;
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

        const event: NoteEdited = { type: "notes.edited", noteId: note.id };
        await emit(tx, event);

        return await findNote(tx, note.id);
    });
};

/**
 * Uncounts the replies of an account about to be deleted from the notes they reply to, before its
 * notes go with it.
 */
export const uncountRepliesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountRepliesBy(ctx, event.accountId);
};
