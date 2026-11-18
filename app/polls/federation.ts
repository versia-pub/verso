/**
 * Votes in polls, as Versia has them: local users' ballots in remote polls, which Verso sends, and
 * remote users' ballots in local polls, which Verso receives. A ballot is one Vote with all of a
 * voter's choices. Votes are private, so only the instance of a poll's author can fetch them.
 * @see https://versia.pub/extensions/polls
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { findAccount, instancesHosting } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import { withHosts } from "../federation/references.ts";
import type { EntityType } from "../federation/registry.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { findNote } from "../notes/note_queries.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { hasRemoteBallot, receiveBallot, withdrawRemoteBallot } from "./ballots.ts";
import { isPollVoted } from "./events.ts";
import {
    ballotOf,
    choicesOf,
    findBallot,
    findPoll,
    type PollBallotRow,
    pollOf,
} from "./poll_queries.ts";

const typeName = "pub.versia:polls/Vote";

/** A local user's ballot as a Versia Vote, if its user, poll and status still exist. */
const renderVersiaVote = async (
    ctx: Context,
    ballot: PollBallotRow,
): Promise<v0_7.Vote | undefined> => {
    const poll = await findPoll(ctx, ballot.poll_id);
    const [author] = withHosts(ctx, await userReferences(ctx, [ballot.account_id]));
    const note = poll && (await noteReferenceMap(ctx, [poll.note_id])).get(poll.note_id);
    const [target] = withHosts(ctx, note === undefined ? [] : [note]);
    const options = await choicesOf(ctx, ballot);
    if (author === undefined || target === undefined || options.length === 0) return undefined;

    return {
        type: typeName,
        id: ballot.id,
        created_at: ballot.created_at.toISOString(),
        ...ballot.updated_at ? { updated_at: ballot.updated_at.toISOString() } : {},
        author,
        target,
        options,
    };
};

/**
 * Sends a local user's ballot in a remote poll to the instance of the poll's author, as one Vote
 * with all their choices, because only that instance counts them. It is sent again with more
 * choices. Votes in local polls have no instance to go to, so nothing is sent.
 */
export const voteDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isPollVoted(event)) return;

    const note = await findNote(ctx, event.noteId);
    const audience = note ? await instancesHosting(ctx, [note.account_id]) : [];
    if (note === undefined || audience.length === 0) return;

    const ballot = await ballotOf(ctx, event.pollId, event.accountId);
    const entity = ballot && await renderVersiaVote(ctx, ballot);
    if (entity === undefined) return;

    await queueDeliveriesTo(ctx, entity, { instanceIds: audience });
};

/** The poll of the local status that `vote` is for, if there is one. */
const votedPoll = async (ctx: Context, vote: v0_7.Vote) => {
    const note = await knownNoteRow(ctx, v0_7.parseReference(vote.target));
    if (note === undefined || note.instance_id !== null) return undefined;

    return await pollOf(ctx, note.id);
};

/**
 * Votes in polls. A remote user's Vote in a local poll is their ballot, and one sent again with
 * other options changes it, as long as the poll hasn't ended. A Delete withdraws it. It is counted
 * by Mastodon's rules for a local user's votes. A Vote that poll's rules refuse is given up on,
 * rather than refused with the `422` Versia specifies, because the inbox answers before it
 * receives an entity. Votes in remote polls are counted by their instances, so they are dropped.
 * A local user's ballot in a remote poll is fetched by the instance of the poll's author.
 */
export const voteType: EntityType<v0_7.Vote> = {
    type: typeName,
    extension: v0_7.pollsKey,
    schema: v0_7.Vote,
    // A voter may change back to their earlier choices.
    resendable: true,
    // Only its author's instance may send it.
    authority: (vote) => v0_7.parseReference(vote.author)?.host,
    // The author is often new to Verso, but is only fetched for a vote Verso will count.
    prepare: async (ctx, vote, _sender, budget) => {
        if (await votedPoll(ctx, vote) === undefined) return;

        const author = v0_7.parseReference(vote.author);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
    },
    receive: async (ctx, vote) => {
        const voted = await votedPoll(ctx, vote);
        if (voted === undefined) return;

        const reference = v0_7.parseReference(vote.author);
        const user = reference && await knownUser(ctx, reference);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${vote.author}`);

        await receiveBallot(ctx, voted, user.id, vote);
    },
    hasRemote: (ctx, id, sender) => hasRemoteBallot(ctx, sender.instanceId, id),
    deleteRemote: (ctx, id, sender) => withdrawRemoteBallot(ctx, sender.instanceId, id),
    // Only the instance of the poll's author counts it.
    find: async (ctx, id, requester) => {
        const ballot = await findBallot(ctx, id);
        if (ballot === undefined) return undefined;

        const poll = await findPoll(ctx, ballot.poll_id);
        const note = poll && await findNote(ctx, poll.note_id);
        const voter = await findAccount(ctx, ballot.account_id);
        const author = note && await findAccount(ctx, note.account_id);
        if (voter?.domain !== null || author?.domain !== requester) return undefined;

        return await renderVersiaVote(ctx, ballot);
    },
};
