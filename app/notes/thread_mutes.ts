/**
 * Muting threads, which Mastodon calls muting a conversation: the user isn't notified of anything
 * about the statuses in it from then on.
 * @see https://docs.joinmastodon.org/methods/statuses/#mute
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import { deleteThreadMute, insertThreadMute } from "./thread_mute_queries.ts";
import { visibleOriginal } from "./visibility.ts";

/**
 * Mutes or unmutes, for `accountId`, the thread of a status, or of the status a boost boosts.
 * Returns the status, or `undefined` if there is none `accountId` may see.
 */
export const setThreadMuted = (
    ctx: Context,
    accountId: string,
    noteId: string,
    muted: boolean,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleOriginal(tx, noteId, accountId);
        if (note === undefined) return undefined;

        if (muted) await insertThreadMute(tx, accountId, note.thread_id);
        else await deleteThreadMute(tx, accountId, note.thread_id);

        return note;
    });
