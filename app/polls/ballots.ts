/**
 * Remote users' ballots in local polls, as the Votes their instances send, and Deletes that
 * withdraw them. A voter has one ballot in a poll, which a Vote sent again changes.
 * @see https://versia.pub/extensions/polls
 * @module
 */
import type { v0_7 } from "@versia/protocol";
import { isDiscardedVersion } from "../federation/versions.ts";
import { HttpError } from "../http/errors.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { PollVoted } from "./events.ts";
import {
    ballotOf,
    choicesOf,
    deleteBallot,
    findPoll,
    findRemoteBallot,
    insertRemoteBallot,
    type PollWithOptions,
    recountPoll,
    remoteBallotOf,
    setBallotUpdatedAt,
    setChoices,
} from "./poll_queries.ts";
import { checkVote, hasEnded, hasUnknownChoice, lockPoll, votable } from "./polls.ts";

const emitVoted = async (ctx: Context, poll: PollWithOptions, accountId: string): Promise<void> => {
    const event: PollVoted = {
        type: "polls.voted",
        pollId: poll.id,
        noteId: poll.note_id,
        accountId,
    };
    await emit(ctx, event);
};

/**
 * Applies the Vote `vote` by the user `accountId` to the local poll `poll`. A Vote that arrives
 * again changes the ballot it first made, so a voter may change their choices. Throws
 * `PermanentFailure` for a Vote that may not count, because the inbox has answered already.
 */
export const receiveBallot = async (
    ctx: Context,
    poll: PollWithOptions,
    accountId: string,
    vote: v0_7.Vote,
): Promise<void> => {
    await lockPoll(ctx, poll.id);

    // A Vote's target can't change.
    const other = await remoteBallotOf(ctx, accountId, vote.id);
    if (other && other.poll_id !== poll.id) return;

    const choices = vote.options.toSorted((a, b) => a - b);
    const updatedAt = vote.updated_at ? new Date(vote.updated_at) : null;
    const ballot = await ballotOf(ctx, poll.id, accountId);
    if (ballot) {
        if (ballot.remote_id !== vote.id) {
            throw new PermanentFailure(`${vote.author} has voted in ${vote.target} already`);
        }

        const held = { createdAt: ballot.created_at, updatedAt: ballot.updated_at };
        if (isDiscardedVersion(held, vote) || hasEnded(ctx, poll)) return;

        // The messages are Mastodon's.
        if (hasUnknownChoice(poll, choices)) {
            throw new PermanentFailure(
                `${vote.author} may not vote so: The chosen vote option does not exist`,
            );
        }
        if (!poll.multiple && choices.length !== 1) {
            throw new PermanentFailure(
                `${vote.author} may not vote so: You have already voted on this poll`,
            );
        }

        const chosen = await choicesOf(ctx, ballot);
        if (chosen.join() === choices.join()) {
            await setBallotUpdatedAt(ctx, ballot, updatedAt);
            return;
        }

        await setChoices(ctx, ballot, choices, updatedAt);
        await recountPoll(ctx, poll.id);
        await emitVoted(ctx, poll, accountId);
        return;
    }

    try {
        const found = await votable(ctx, accountId, poll.id);
        if (found === undefined) {
            throw new PermanentFailure(`${vote.author} may not see ${vote.target}`);
        }

        checkVote(ctx, found.poll, found.note, accountId, choices, []);
    } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        throw new PermanentFailure(
            `${vote.author} may not vote so: ${error.description ?? error.message}`,
        );
    }

    await insertRemoteBallot(ctx, {
        id: ctx.ids(),
        poll_id: poll.id,
        account_id: accountId,
        remote_id: vote.id,
        created_at: new Date(vote.created_at),
        updated_at: updatedAt,
    }, choices);
    await recountPoll(ctx, poll.id);
    await emitVoted(ctx, poll, accountId);
};

/** Whether Verso has the Vote `id` of a user of the instance `instanceId`. */
export const hasRemoteBallot = async (
    ctx: Context,
    instanceId: string,
    id: string,
): Promise<boolean> => await findRemoteBallot(ctx, instanceId, id) !== undefined;

/**
 * Withdraws the Vote `id` of a user of the instance `instanceId`, and counts the poll again. A poll
 * that has ended keeps it, because its result is final.
 */
export const withdrawRemoteBallot = async (
    ctx: Context,
    instanceId: string,
    id: string,
): Promise<void> => {
    const found = await findRemoteBallot(ctx, instanceId, id);
    if (found === undefined) return;

    // Read again under the lock, in case a Vote changed it meanwhile.
    await lockPoll(ctx, found.poll_id);
    const ballot = await findRemoteBallot(ctx, instanceId, id);
    const poll = ballot && await findPoll(ctx, ballot.poll_id);
    if (ballot === undefined || poll === undefined || hasEnded(ctx, poll)) return;

    await deleteBallot(ctx, ballot);
    await recountPoll(ctx, poll.id);
    await emitVoted(ctx, poll, ballot.account_id);
};
