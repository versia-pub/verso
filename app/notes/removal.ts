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
 * Deletes a note, uncounting it, and the shares of it, which go with it. Returns whether there was
 * one.
 */
export const removeNote = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        // Read while they are there: the event says who could see the note, so they can be told.
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
 * Uncounts what goes with an account about to be deleted, before it does: its replies, from the
 * notes they reply to, its shares, from the notes they share, and the shares of its notes, from
 * the accounts that made them.
 */
export const uncountNotesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountAmong(ctx, notesOfQuery(ctx, event.accountId));
};

/** Uncounts what goes with `notes`, as {@link uncountNotesOf} does. */
const uncountAmong = async (ctx: Context, notes: NoteIdQuery) => {
    await uncountRepliesAmong(ctx, notes);
    await uncountSharesAmong(ctx, notes);
    await uncountSharersOfAmong(ctx, notes);
};

/** How many notes of an account are removed in each transaction, before it is deleted. */
const removalBatch = 500;

/**
 * Removes the notes and shares of `accountId`, a remote account about to be deleted, uncounting
 * what goes with them, a batch at a time, each in a transaction of its own, so that one with many
 * doesn't hold its locks all at once. Its deletion uncounts any it posts meanwhile.
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
