/**
 * Polls on local statuses, as their authors ask and change them, and votes in polls.
 * @module
 */
import { lockKey } from "../db/locking.ts";
import { blocksBetween } from "../graph/block_queries.ts";
import { NotPermitted, Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { visibleNote } from "../notes/visibility.ts";
import {
    deletePoll,
    findPoll,
    insertPoll,
    insertVotes,
    type NewPoll,
    type PollRow,
    type PollWithOptions,
    updatePoll,
    votesAmong,
} from "./poll_queries.ts";

/** A poll as a local user asks it. */
export type PollDraft = {
    readonly options: readonly string[];
    /** How long it runs from now, in seconds. */
    readonly expiresIn: number;
    readonly multiple: boolean;
    readonly hideTotals: boolean;
};

const asNewPoll = (ctx: Context, draft: PollDraft): NewPoll => ({
    options: draft.options,
    multiple: draft.multiple,
    hideTotals: draft.hideTotals,
    expiresAt: new Date(ctx.clock.now().getTime() + draft.expiresIn * 1000),
});

/** Whether a poll asks something else, which its votes don't answer. */
const asksAnew = (poll: PollWithOptions, changes: NewPoll) =>
    poll.multiple !== changes.multiple ||
    poll.options.map((option) => option.title).join("\n") !== changes.options.join("\n");

/** Adds the poll `draft` to the new status `noteId`. */
export const addPoll = async (ctx: Context, noteId: string, draft: PollDraft): Promise<void> => {
    await insertPoll(ctx, noteId, asNewPoll(ctx, draft));
};

/**
 * Whether editing a status with the poll `poll` changes it. A `draft` of `undefined` leaves it as
 * it is, and `null` removes it. Its end is set anew from now, as on Mastodon.
 */
export const changesPoll = (
    ctx: Context,
    poll: PollWithOptions | undefined,
    draft: PollDraft | null | undefined,
): boolean => {
    if (draft === undefined) return false;
    if (draft === null || poll === undefined) return draft !== null || poll !== undefined;

    const changes = asNewPoll(ctx, draft);
    return asksAnew(poll, changes) || poll.hide_totals !== changes.hideTotals ||
        poll.expires_at?.getTime() !== changes.expiresAt?.getTime();
};

/**
 * Changes the poll of the status `noteId`, which is `poll`, as {@link changesPoll} says. A poll that
 * asks something else loses its votes.
 */
export const changePoll = async (
    ctx: Context,
    noteId: string,
    poll: PollWithOptions | undefined,
    draft: PollDraft | null | undefined,
): Promise<void> => {
    if (draft === undefined) return;
    if (draft === null) {
        if (poll) await deletePoll(ctx, poll);
        return;
    }

    const changes = asNewPoll(ctx, draft);
    if (poll === undefined) return await insertPoll(ctx, noteId, changes);
    await updatePoll(ctx, poll, changes, asksAnew(poll, changes));
};

/** Whether `poll` has ended. */
export const hasEnded = (ctx: Context, poll: PollRow): boolean =>
    poll.expires_at !== null && poll.expires_at <= ctx.clock.now();

/**
 * Votes as `accountId` for the options `choices` of the poll `pollId`, as Mastodon allows: once, or
 * in a poll of several choices, once for each, before it ends, and not in one's own polls. Returns
 * the poll, or `undefined` if there is none or `accountId` may not see its status.
 */
export const vote = (
    ctx: Context,
    accountId: string,
    pollId: string,
    choices: readonly number[],
): Promise<PollWithOptions | undefined> =>
    ctx.transaction(async (tx) => {
        // So that two votes by one account can't both count as its first.
        await lockKey(tx.db, `vote:${pollId}:${accountId}`);

        const poll = await findPoll(tx, pollId);
        const note = poll && await visibleNote(tx, poll.note_id, accountId);
        if (poll === undefined || note === undefined) return undefined;

        const { blocking, blockedBy } = await blocksBetween(tx, accountId, [note.account_id]);
        if (blocking.size > 0 || blockedBy.size > 0) throw new NotPermitted();

        // As Mastodon words its errors.
        if (hasEnded(tx, poll)) throw new Unprocessable("The poll has already ended");
        if (choices.some((choice) => choice < 0 || choice >= poll.options.length)) {
            throw new Unprocessable("The chosen vote option does not exist");
        }
        if (note.account_id === accountId) {
            throw new Unprocessable("You cannot vote in your own polls");
        }

        const voted = (await votesAmong(tx, accountId, [poll.id])).get(poll.id) ?? [];
        const again = poll.multiple
            ? new Set(choices).size < choices.length || choices.some((c) => voted.includes(c))
            : voted.length > 0 || choices.length > 1;
        if (again) throw new Unprocessable("You have already voted on this poll");

        await insertVotes(tx, poll, accountId, choices, voted.length > 0);
        return await findPoll(tx, poll.id);
    });
