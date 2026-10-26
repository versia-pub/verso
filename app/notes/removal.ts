import { isAccountDeleting } from "../accounts/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { NoteDeleted } from "./events.ts";
import { deleteNote, mentionsOf } from "./note_queries.ts";
import { countPosted } from "./notes.ts";
import {
    deleteNotes,
    type NoteIdQuery,
    notesAmongQuery,
    notesOfQuery,
    someNoteIdsOf,
    uncountRepliesAmong,
} from "./removal_queries.ts";
import { uncountSharersOf, uncountSharersOfAmong, uncountSharesAmong } from "./share_queries.ts";

/**
 * Deletes a status, decrementing its counts, along with the boosts of it. Returns whether it
 * existed.
 */
export const removeNote = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        // Read while they still exist: the event says who could see the status, so they can be
        // notified.
        const mentionIds = (await mentionsOf(tx, [id])).get(id) ?? [];
        await uncountSharersOf(tx, id);
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

/**
 * Decrements the counts that depend on an account about to be deleted, before it is deleted: the
 * reply counts of the statuses it replied to, the boost counts of the statuses it boosted, and the
 * boost counts of the accounts that boosted its statuses.
 */
export const uncountNotesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountAmong(ctx, notesOfQuery(ctx, event.accountId));
};

/** Decrements the counts that depend on `notes`, as {@link uncountNotesOf} does. */
const uncountAmong = async (ctx: Context, notes: NoteIdQuery) => {
    await uncountRepliesAmong(ctx, notes);
    await uncountSharesAmong(ctx, notes);
    await uncountSharersOfAmong(ctx, notes);
};

/** How many statuses of an account are removed in each transaction, before it is deleted. */
const removalBatch = 500;

/**
 * Removes the statuses and boosts of `accountId`, a remote account about to be deleted,
 * decrementing the counts that depend on them, one batch at a time, each in its own transaction, so
 * that an account with many statuses doesn't hold all its locks at once. Deleting the account then
 * decrements the counts of any it posted in the meantime.
 */
export const removeNotesOf = async (ctx: Context, accountId: string): Promise<void> => {
    while (true) {
        const removed = await ctx.transaction(async (tx) => {
            const ids = await someNoteIdsOf(tx, accountId, removalBatch);
            if (ids.length === 0) return 0;

            await uncountAmong(tx, notesAmongQuery(tx, ids));
            await deleteNotes(tx, ids);

            return ids.length;
        });

        if (removed < removalBatch) return;
    }
};
