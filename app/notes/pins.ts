/**
 * Pins: statuses that their authors feature on their profiles, as Mastodon has them.
 * @see https://docs.joinmastodon.org/methods/statuses/#pin
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import { visibleNote } from "./visibility.ts";
import { countPins, deletePin, insertPin, pinnedAmong } from "./pin_queries.ts";

/** How many statuses an account may pin, as on Mastodon. */
export const pinLimit = 5;

/**
 * Whether a status can be pinned by its author: it must be theirs, and neither a boost nor direct.
 */
export const isPinnable = (note: NoteRow, accountId: string): boolean =>
    note.account_id === accountId && note.reblog_of_id === null && note.visibility !== "direct";

/** The result of pinning a status. */
export type PinResult =
    /** The status, pinned now or already. */
    | NoteRow
    /** There is no such status that the account may see. */
    | "missing"
    /** The status can't be pinned by the account. */
    | "unpinnable"
    /** The account already pins as many statuses as it may. */
    | "full";

/** Pins a status for `accountId`, its author. */
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

/** Unpins a status for `accountId`. Returns it, or `undefined` if there is none it may see. */
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
