/**
 * Likes of notes, which Mastodon calls favourites.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { isAccountDeleting } from "../accounts/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { visibleNote } from "../notes/notes.ts";
import { countLike, deleteLike, insertLike, uncountLikesBy } from "./like_queries.ts";

/**
 * Likes a note for `accountId`, and counts it, unless it already likes it. Returns the note as it
 * is now, or `undefined` if there is none `accountId` may see.
 */
export const like = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleNote(tx, noteId, accountId);
        if (note === undefined) return undefined;

        if (await insertLike(tx, accountId, note.id)) await countLike(tx, note.id, 1);
        return await findNote(tx, note.id);
    });

/**
 * Undoes `accountId`'s like of a note, and uncounts it. Returns the note as it is now, or
 * `undefined` if there is none. As on Mastodon, a note it liked can be unliked even if it may no
 * longer see it, and one it didn't only if it may.
 */
export const unlike = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        if (await deleteLike(tx, accountId, noteId) === undefined) {
            return await visibleNote(tx, noteId, accountId);
        }

        await countLike(tx, noteId, -1);
        return await findNote(tx, noteId);
    });

/** Uncounts the likes of an account about to be deleted, before they go with it. */
export const uncountLikesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountLikesBy(ctx, event.accountId);
};
