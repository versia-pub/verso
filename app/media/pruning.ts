/**
 * Pruning the files cached for remote attachments: those cached longer ago than `remote_media_days`
 * are removed, and the media proxy fetches them again if anyone asks for them, as on Mastodon.
 * Avatars, headers and custom emojis stay cached until nothing uses them.
 * @module
 */
import { z } from "zod";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { enqueueFileCleanup } from "./cleanup.ts";
import { oldCachedQuery, uncacheMedia } from "./pruning_queries.ts";

/** Prunes the files of old cached remote attachments, a batch at a time. */
export const mediaPruneQueue = "remote-media-prune";

/** Starts {@link mediaPruneQueue}'s work each day. */
export const mediaPruneStartQueue = "remote-media-prune-start";

/** How many media one job prunes. */
const mediaPerJob = 500;

const PruneJob = z.object({
    before: z.iso.datetime().transform((value) => new Date(value)),
    batch: z.int(),
});

/** Queues a batch of the pass over what was cached before `before`, the `batch`th. */
const enqueueBatch = (ctx: Context, before: Date, batch: number) =>
    enqueue(ctx, {
        queue: mediaPruneQueue,
        payload: { before: before.toISOString(), batch },
        dedupeKey: `${mediaPruneQueue}:${before.toISOString()}:${batch}`,
    });

/** Queues a pass over the attachments cached more than `remote_media_days` ago. */
export const startMediaPruning = async (ctx: Context): Promise<void> => {
    await enqueueBatch(ctx, new Date(ctx.clock.now().getTime() - ctx.settings.remoteMediaMs), 0);
};

/** Prunes the next batch of a pass, and queues the job for the batch after, if there may be one. */
export const mediaPruneHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = PruneJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a media prune job");

    const { before, batch } = payload.data;
    await ctx.transaction(async (tx) => {
        if (await pruneBatch(tx, before) === mediaPerJob) await enqueueBatch(tx, before, batch + 1);
    });
};

/**
 * Prunes the files of the remote attachments cached before `before`, a batch to a transaction.
 * Returns how many attachments it marked as not cached.
 */
export const pruneRemoteMedia = async (ctx: Context, before: Date): Promise<number> => {
    let total = 0;
    while (true) {
        const cleared = await ctx.transaction((tx) => pruneBatch(tx, before));
        total += cleared;
        if (cleared < mediaPerJob) return total;
    }
};

/**
 * Prunes a batch of what was cached before `before`, and queues the removal of the files it
 * stopped using. Pruned media is no longer cached, so the next batch doesn't find it again. Returns
 * how many it marked as not cached.
 */
const pruneBatch = async (ctx: Context, before: Date): Promise<number> => {
    const batch = await oldCachedQuery(ctx, before, mediaPerJob).execute();
    if (batch.length === 0) return 0;

    const cleared = await uncacheMedia(ctx, batch.map((row) => row.id), before);
    await enqueueFileCleanup(ctx, batch.flatMap((row) => [row.sha256, row.preview_sha256]));

    return cleared;
};
