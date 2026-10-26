import type { Visibility } from "../accounts/tables.ts";
import { followedSubquery, isFollowing } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, isMentioned, type NoteRow } from "./note_queries.ts";
import { notesSeenBy, type Onlooker } from "./thread_queries.ts";

/**
 * Whether `viewerId`, or anyone if it is `null`, may see `note`. Public and unlisted notes are for
 * anyone, private ones for the author's followers, and direct ones for those they mention, who
 * may always see a note, as may its author. A share is seen only by those who may see what it
 * shares too, which can have been made private since.
 */
export const canSee = async (
    ctx: Context,
    note: NoteRow,
    viewerId: string | null,
): Promise<boolean> => {
    if (note.reblog_of_id !== null) {
        const shared = await findNote(ctx, note.reblog_of_id);
        if (shared === undefined || !await canSee(ctx, shared, viewerId)) return false;
    }

    if (note.visibility === "public" || note.visibility === "unlisted") return true;
    if (viewerId === null) return false;
    if (viewerId === note.account_id || await isMentioned(ctx, note.id, viewerId)) return true;

    return note.visibility === "private" && await isFollowing(ctx, viewerId, note.account_id);
};

/** Someone looking at notes, as queries of many of them take them, or `null` for anyone. */
export const onlookerOf = (ctx: Context, viewerId: string | null): Onlooker =>
    viewerId === null ? null : { id: viewerId, followed: followedSubquery(ctx, viewerId) };

/**
 * Which of `ids`, notes that aren't shares, `viewerId`, or anyone if it is `null`, may see, as
 * {@link canSee} decides one at a time, in one query.
 */
export const seenAmong = (
    ctx: Context,
    ids: readonly string[],
    viewerId: string | null,
): Promise<Set<string>> => notesSeenBy(ctx, ids, onlookerOf(ctx, viewerId));

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
 * The note with this id, or if it is a share, the note it shares, if `viewerId` may see both. What
 * is done to a share, such as liking or replying to it, is done to what it shares, as on Mastodon.
 */
export const visibleOriginal = async (
    ctx: Context,
    id: string,
    viewerId: string | null,
): Promise<NoteRow | undefined> => {
    const note = await visibleNote(ctx, id, viewerId);
    if (note === undefined || note.reblog_of_id === null) return note;

    return await visibleNote(ctx, note.reblog_of_id, viewerId);
};
