/**
 * Votes in polls as Versia has them: local users' votes in remote polls, as Verso sends them, and
 * remote users' votes in local polls, as Verso receives them. Votes are private, so they can't be
 * fetched.
 * @see https://versia.pub/extensions/polls
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { EntityType, Sender } from "../federation/registry.ts";
import { HttpError } from "../http/errors.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { findNote } from "../notes/note_queries.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isPollVoted } from "./events.ts";
import { findVotes, pollOf } from "./poll_queries.ts";
import { castVotes } from "./polls.ts";

const typeName = "pub.versia:polls/Vote";

/**
 * Sends a local user's votes in a remote poll to the instance of the poll's author, a Vote for each
 * option, as only it counts them. Votes in local polls, the only ones remote users' are counted in,
 * have no instance to go to, so nothing is sent.
 */
export const voteDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isPollVoted(event)) return;

    const note = await findNote(ctx, event.noteId);
    const audience = note ? await instancesHosting(ctx, [note.account_id]) : [];
    if (note === undefined || audience.length === 0) return;

    const [author] = await userReferences(ctx, [event.accountId]);
    const poll = (await noteReferenceMap(ctx, [note.id])).get(note.id);
    if (author === undefined || poll === undefined) return;

    for (const vote of await findVotes(ctx, event.voteIds)) {
        const entity: v0_6.Vote = {
            type: typeName,
            id: vote.id,
            created_at: vote.created_at.toISOString(),
            author,
            poll,
            option: vote.choice,
        };
        await queueDeliveriesTo(ctx, entity, { instanceIds: audience });
    }
};

/** The poll of the local status that a Vote sent by `sender` is for, if there is one. */
const votedPoll = async (ctx: Context, vote: v0_6.Vote, sender: Sender) => {
    const note = await knownNoteRow(ctx, parseReference(vote.poll, sender.domain));
    if (note === undefined || note.instance_id !== null) return undefined;

    return await pollOf(ctx, note.id);
};

/**
 * Votes by remote users in local polls, as their instances send them, a Vote for each option. They
 * are counted as Mastodon counts local users' votes, so that a Vote for a poll that ended, or that
 * its author may not cast, is given up on, rather than refused with a `422`, as Versia says, since
 * the inbox answers before it receives an entity. A Vote sent again counts once. Votes in remote
 * polls are their instances' to count, so they are dropped.
 */
export const voteType: EntityType<v0_6.Vote> = {
    type: typeName,
    extension: v0_6.pollsKey,
    schema: v0_6.Vote,
    // Only its author's instance may send it.
    authority: (vote, origin) => parseReference(vote.author, origin)?.host,
    // The author is often new to Verso, but is only fetched for a vote Verso will count.
    prepare: async (ctx, vote, sender, budget) => {
        if (await votedPoll(ctx, vote, sender) === undefined) return;

        const author = parseReference(vote.author, sender.domain);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
    },
    receive: async (ctx, vote, sender) => {
        const voted = await votedPoll(ctx, vote, sender);
        if (voted === undefined) return;

        const reference = parseReference(vote.author, sender.domain);
        const user = reference && await knownUser(ctx, reference);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${vote.author}`);

        try {
            const poll = await castVotes(ctx, user.id, voted.id, [vote.option], true);
            if (poll === undefined) {
                throw new PermanentFailure(`${vote.author} may not see ${vote.poll}`);
            }
        } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            throw new PermanentFailure(
                `${vote.author} may not vote so: ${error.description ?? error.message}`,
            );
        }
    },
};
