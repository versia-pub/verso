/**
 * Pins: notes their authors feature on their profiles, as Mastodon has them.
 * @see https://docs.joinmastodon.org/methods/statuses/#pin
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import { visibleNote } from "./visibility.ts";
import { countPins, deletePin, insertPin, pinnedAmong } from "./pin_queries.ts";

/** How many notes an account may pin, as on Mastodon. */
export const pinLimit = 5;

/** Whether a note can be pinned by its author: one of theirs, not a share, nor direct. */
export const isPinnable = (note: NoteRow, accountId: string): boolean =>
    note.account_id === accountId && note.reblog_of_id === null && note.visibility !== "direct";

/** What became of pinning a note. */
export type PinResult =
    /** The note, pinned, now or already. */
    | NoteRow
    /** There is no such note the account may see. */
    | "missing"
    /** It isn't one the account can pin. */
    | "unpinnable"
    /** The account pins as many notes as it may. */
    | "full";

/** Pins a note for `accountId`, its author. */
export const pin = (ctx: Context, accountId: string, noteId: string): Promise<PinResult> =>
    ctx.transaction(async (tx) => {
        const note = await visibleNote(tx, noteId, accountId);
        if (note === undefined) return "missing";
        if (!isPinnable(note, accountId)) return "unpinnable";

        const pinned = (await pinnedAmong(tx, accountId, [note.id])).has(note.id);
        if (!pinned && await countPins(tx, accountId) >= pinLimit) return "full";

        await insertPin(tx, accountId, note.id);
        return note;
    });

/** Unpins a note for `accountId`. Returns it, or `undefined` if there is none it may see. */
export const unpin = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleNote(tx, noteId, accountId);
        if (note !== undefined) await deletePin(tx, accountId, note.id);

        return note;
    });
