/**
 * Notes, on this instance or another: posting them, who may see them, and deleting them.
 * @module
 */
import { type AccountRow, countNote, findAccount } from "../accounts/accounts.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { userUri } from "../accounts/render.ts";
import { isAccountDeleting } from "../accounts/events.ts";
import type { TextFormat, Visibility } from "../accounts/tables.ts";
import { isFollowing } from "../graph/follows.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type Mention, renderText, scanText } from "../kernel/markup.ts";
import type { NoteDeleted, NotePosted } from "./events.ts";
import {
    countReply,
    deleteNote,
    findNote,
    insertNote,
    mentions,
    mentionsOf,
    type NoteRow,
    uncountRepliesBy,
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

/** The note with this id, if there is one and `viewerId` may see it. */
export const visibleNote = async (
    ctx: Context,
    id: string,
    viewerId: string | null,
): Promise<NoteRow | undefined> => {
    const note = await findNote(ctx, id);
    return note && await canSee(ctx, note, viewerId) ? note : undefined;
};

/** Deletes a note, uncounting it. Returns whether there was one. */
export const removeNote = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        // Read while they are there: the event says who could see the note, so they can be told.
        const mentionIds = (await mentionsOf(tx, [id])).get(id) ?? [];
        const note = await deleteNote(tx, id);
        if (note === undefined) return false;

        await countNote(tx, note.account_id, -1, note.created_at);
        if (note.in_reply_to_id !== null) await countReply(tx, note.in_reply_to_id, -1);

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

/**
 * The accounts `mentions` are of, by {@link mentionKey}, with other instances' users fetched if
 * Verso doesn't have them. Mentions of no one are left out.
 */
const mentioned = async (ctx: Context, mentions: readonly Mention[]) => {
    const accounts = new Map<string, AccountRow>();

    for (const mention of mentions) {
        const { username, domain } = mention;
        const address = parseAddress(ctx, domain === null ? username : `${username}@${domain}`);
        const row = address && await findAccountByAddress(ctx, address, { fetch: true });
        if (row) accounts.set(mentionKey(mention), row);
    }

    return accounts;
};

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

        const html = renderText(draft.text, draft.format, {
            mention: (mention) => {
                const row = accounts.get(mentionKey(mention));
                return row && userUri(tx, row);
            },
            hashtag: (tag) => tx.urls.url`/tags/${tag.toLowerCase()}`,
        });
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

        await countNote(tx, accountId, 1, note.created_at);
        if (parent !== undefined) await countReply(tx, parent.id, 1);

        const event: NotePosted = { type: "notes.posted", noteId: note.id };
        await emit(tx, event);

        return note;
    });
};

/**
 * Uncounts the replies of an account about to be deleted from the notes they reply to, before its
 * notes go with it.
 */
export const uncountRepliesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountRepliesBy(ctx, event.accountId);
};
