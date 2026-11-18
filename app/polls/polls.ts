/**
 * Polls on local statuses, as their authors ask and change them, and votes in polls.
 * @module
 */
import { lockKey } from "../db/locking.ts";
import { blocksBetween } from "../graph/block_queries.ts";
import { NotPermitted, Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { visibleNote } from "../notes/visibility.ts";
import type { PollVoted } from "./events.ts";
import {
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
export const asksAnew = (poll: PollWithOptions, changes: NewPoll): boolean =>
    poll.multiple !== changes.multiple ||
    poll.options.map((option) => option.title).join("\n") !== changes.options.join("\n");

/** Adds the poll `draft` to the new status `noteId`. */
export const addPoll = async (ctx: Context, noteId: string, draft: PollDraft): Promise<void> => {
    await insertPoll(ctx, noteId, asNewPoll(ctx, draft));
};

/**
 * Throws `Unprocessable` if editing a status with the poll `poll` to have the poll `draft` would
 * add a poll, remove one, or change what it asks. A `draft` of `undefined` leaves it as it is, and
 * `null` removes it. A poll's options and whether it allows several choices can't change, since
 * votes in it answer them.
 */
export const checkPollEdit = (
    ctx: Context,
    poll: PollWithOptions | undefined,
    draft: PollDraft | null | undefined,
): void => {
    if (draft === undefined || draft === null && poll === undefined) return;

    if (draft === null || poll === undefined || asksAnew(poll, asNewPoll(ctx, draft))) {
        throw new Unprocessable("The poll's options can't be changed");
    }
};

/**
 * Whether editing a status with the poll `poll` to have the poll `draft` changes it, once
 * {@link checkPollEdit} allows it. Its end is set anew from now, like Mastodon does.
 */
export const changesPoll = (
    ctx: Context,
    poll: PollWithOptions | undefined,
    draft: PollDraft | null | undefined,
): boolean => {
    if (!draft || poll === undefined) return false;

    const changes = asNewPoll(ctx, draft);
    return poll.hide_totals !== changes.hideTotals ||
        poll.expires_at?.getTime() !== changes.expiresAt?.getTime();
};

/** Applies the change {@link changesPoll} reports to `poll`, the poll of a status. */
export const changePoll = async (
    ctx: Context,
    poll: PollWithOptions | undefined,
    draft: PollDraft | null | undefined,
): Promise<void> => {
    if (!draft || poll === undefined) return;

    await updatePoll(ctx, poll, asNewPoll(ctx, draft));
};

/** Whether `poll` has ended. */
export const hasEnded = (ctx: Context, poll: PollRow): boolean =>
    poll.expires_at !== null && poll.expires_at <= ctx.clock.now();

/**
 * Locks the votes in the poll `pollId`, so that a voter's two changes can't both count as its
 * first, and a recount can't overwrite totals another vote is changing.
 */
export const lockPoll = (ctx: Context, pollId: string): Promise<void> =>
    lockKey(ctx.db, `poll:${pollId}`);

/**
 * The poll `pollId` and its status, if `accountId` may vote in it: there is one, and `accountId`
 * may see the status. Locks the votes in it. Throws `NotPermitted` if `accountId` blocks
 * the status's author.
 */
export const votable = async (
    ctx: Context,
    accountId: string,
    pollId: string,
): Promise<{ readonly poll: PollWithOptions; readonly note: NoteRow } | undefined> => {
    await lockPoll(ctx, pollId);

    const poll = await findPoll(ctx, pollId);
    const note = poll && await visibleNote(ctx, poll.note_id, accountId);
    if (poll === undefined || note === undefined) return undefined;

    // A vote from an account the author blocks counts, so that it can't tell it is blocked.
    const { blocking } = await blocksBetween(ctx, accountId, [note.account_id]);
    if (blocking.size > 0) throw new NotPermitted();

    return { poll, note };
};

/** Whether `choices` has an option that `poll` doesn't have. */
export const hasUnknownChoice = (poll: PollWithOptions, choices: readonly number[]): boolean =>
    choices.some((choice) => choice < 0 || choice >= poll.options.length);

/**
 * Throws `Unprocessable` if `accountId`, who voted for `voted`, may not also vote for `choices` in
 * `poll`, on `note`. Like Mastodon, a vote is allowed once, or in a poll of several choices once for
 * each option, before the poll ends, and not in one's own polls.
 */
export const checkVote = (
    ctx: Context,
    poll: PollWithOptions,
    note: NoteRow,
    accountId: string,
    choices: readonly number[],
    voted: readonly number[],
): void => {
    // The messages are Mastodon's.
    if (hasEnded(ctx, poll)) throw new Unprocessable("The poll has already ended");
    if (hasUnknownChoice(poll, choices)) {
        throw new Unprocessable("The chosen vote option does not exist");
    }
    if (note.account_id === accountId) {
        throw new Unprocessable("You cannot vote in your own polls");
    }

    const again = poll.multiple
        ? new Set(choices).size < choices.length || choices.some((c) => voted.includes(c))
        : voted.length > 0 || choices.length > 1;
    if (again) throw new Unprocessable("You have already voted on this poll");
};

/**
 * Votes as `accountId` for the options `choices` of the poll `pollId`, in `ctx`'s transaction. The
 * rules are {@link checkVote}'s. Returns the poll, or `undefined` if there is none or `accountId`
 * may not see its status.
 */
export const castVotes = async (
    ctx: Context,
    accountId: string,
    pollId: string,
    choices: readonly number[],
): Promise<PollWithOptions | undefined> => {
    const found = await votable(ctx, accountId, pollId);
    if (found === undefined) return undefined;

    const { poll, note } = found;
    const voted = (await votesAmong(ctx, [accountId], [poll.id])).get(accountId)?.get(poll.id) ??
        [];
    checkVote(ctx, poll, note, accountId, choices, voted);

    await insertVotes(ctx, poll, accountId, choices, voted.length > 0);
    const event: PollVoted = {
        type: "polls.voted",
        pollId: poll.id,
        noteId: note.id,
        accountId,
    };
    await emit(ctx, event);

    return await findPoll(ctx, poll.id);
};

/** {@link castVotes}, in a transaction of its own. */
export const vote = (
    ctx: Context,
    accountId: string,
    pollId: string,
    choices: readonly number[],
): Promise<PollWithOptions | undefined> =>
    ctx.transaction((tx) => castVotes(tx, accountId, pollId, choices));
