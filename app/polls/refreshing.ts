/**
 * Remote polls that are fetched again while they are open, so their votes are up to date for the
 * users looking at them. Their instances send the votes too, but not every time.
 * @module
 */
import { z } from "zod";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { domainsOf } from "../instances/instance_queries.ts";
import { findNote } from "../notes/note_queries.ts";
import { pollOf } from "./poll_queries.ts";

/** The queue whose jobs fetch remote polls again. */
export const pollRefreshQueue = "polls-refresh";

const RefreshJob = z.object({ noteId: z.string() });

/**
 * How long a remote poll is shown before a user opening it triggers a fetch. Mastodon waits as
 * long.
 */
export const staleMs = 60_000;

/**
 * The remote status `noteId`, with the time it was fetched, if its poll can have changed since: it
 * was fetched at least a minute ago, and before the poll ended.
 */
const staleStatus = async (ctx: Context, noteId: string) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined || note.instance_id === null || note.remote_id === null) return;
    if (note.reblog_of_id !== null || note.fetched_at === null) return;

    const poll = await pollOf(ctx, note.id);
    if (poll === undefined) return;

    // What was fetched once the poll had ended is final.
    if (poll.expires_at !== null && note.fetched_at >= poll.expires_at) return;
    if (ctx.clock.now().getTime() - note.fetched_at.getTime() < staleMs) return;

    return note;
};

/**
 * Queues a fetch of the remote status `noteId` when a local user opens its poll, if the poll may
 * have changed and no fetch is queued already.
 */
export const refreshPoll = async (ctx: Context, noteId: string): Promise<void> => {
    const note = await staleStatus(ctx, noteId);
    if (note === undefined) return;

    const payload: z.infer<typeof RefreshJob> = { noteId };
    await enqueue(ctx, {
        queue: pollRefreshQueue,
        payload,
        group: note.instance_id ?? undefined,
        maxAttempts: 3,
        dedupeKey: `poll-refresh:${noteId}`,
    });
};

/**
 * Fetches the remote status in the job again, which saves its poll's votes like any status Verso
 * receives. A status that was deleted, or whose poll isn't stale by now, is left alone.
 */
export const pollRefreshHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = RefreshJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a poll refresh job");

    const note = await staleStatus(ctx, payload.data.noteId);
    if (note === undefined || note.instance_id === null || note.remote_id === null) return;

    const [domain] = await domainsOf(ctx, [note.instance_id], "versia");
    if (domain === undefined) return;

    const reference = { host: domain, id: note.remote_id };
    await ctx.federation.resolve(ctx, reference, "Note", undefined, staleMs);
};
