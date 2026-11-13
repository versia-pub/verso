/**
 * Live counts in polls on local statuses. A vote in one queues a job that sends the status again,
 * with the votes so far. Votes that arrive while it waits are sent in the same job, so a popular
 * poll isn't sent with every vote.
 * @see https://docs.joinmastodon.org/spec/activitypub/#Question
 * @module
 */
import { z } from "zod";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { findNote } from "../notes/note_queries.ts";
import { isPollVoted, type PollUpdated } from "./events.ts";
import { findPoll, type PollWithOptions } from "./poll_queries.ts";
import { hasEnded } from "./polls.ts";

/** The queue whose jobs send local polls again with their votes. */
export const pollUpdatesQueue = "polls-updated";

const UpdateJob = z.object({ pollId: z.string() });

/** How long after a vote the poll is sent. Mastodon waits as long. */
export const updateDelayMs = 3 * 60_000;

/**
 * The poll `pollId`, if its status is a local one and its votes are to be sent now. That means it
 * hasn't ended, because its results are sent when it does, and it doesn't hide its totals.
 */
const livePoll = async (ctx: Context, pollId: string): Promise<PollWithOptions | undefined> => {
    const poll = await findPoll(ctx, pollId);
    if (poll === undefined || poll.hide_totals || hasEnded(ctx, poll)) return undefined;

    const note = await findNote(ctx, poll.note_id);
    return note?.instance_id === null ? poll : undefined;
};

/** Queues the sending of a local poll that someone voted in, unless one is queued already. */
export const queuePollUpdate = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isPollVoted(event) || await livePoll(ctx, event.pollId) === undefined) return;

    const payload: z.infer<typeof UpdateJob> = { pollId: event.pollId };
    await enqueue(ctx, {
        queue: pollUpdatesQueue,
        payload,
        runAt: new Date(ctx.clock.now().getTime() + updateDelayMs),
        maxAttempts: 3,
        dedupeKey: `poll-update:${event.pollId}`,
    });
};

/**
 * Emits that the poll in the job is to be sent again. A poll that was deleted, ended or changed to
 * hide its totals since the vote isn't.
 */
export const pollUpdateHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = UpdateJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a poll update job");

    await ctx.transaction(async (tx) => {
        const poll = await livePoll(tx, payload.data.pollId);
        if (poll === undefined) return;

        const event: PollUpdated = {
            type: "polls.updated",
            pollId: poll.id,
            noteId: poll.note_id,
        };
        await emit(tx, event);
    });
};
