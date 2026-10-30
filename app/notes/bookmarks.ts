/**
 * Bookmarks: statuses that local users keep for later, which only they see and which aren't
 * federated.
 * @see https://docs.joinmastodon.org/methods/bookmarks/
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { deleteBookmark, insertBookmark } from "./bookmark_queries.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { visibleNote, visibleOriginal } from "./visibility.ts";

/**
 * Bookmarks a status for `accountId`, or the status a boost boosts, as Mastodon does. Returns it, or
 * `undefined` if there is none `accountId` may see.
 */
export const bookmark = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleOriginal(tx, noteId, accountId);
        if (note !== undefined) await insertBookmark(tx, accountId, note.id);

        return note;
    });

/**
 * Removes `accountId`'s bookmark of a status, or of the status a boost boosts. Returns it, or
 * `undefined` if there is none. A bookmarked status can be removed even if the account may no
 * longer see it, and one it didn't bookmark is only returned if it may see it, as with likes.
 */
export const unbookmark = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const bookmarked = (await findNote(tx, noteId))?.reblog_of_id ?? noteId;

        const removed = await deleteBookmark(tx, accountId, bookmarked);
        return removed
            ? await findNote(tx, bookmarked)
            : await visibleNote(tx, bookmarked, accountId);
    });
