/**
 * Removing what nothing uses: media, local or remote, that no status, scheduled status, account or
 * emoji used within the time the settings give, and the files that no media uses, local or cached.
 * @module
 */
import { z } from "zod";
import { lockKey } from "../db/locking.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { deleteUnusedMedia, isFileUsed, type MediaCursor } from "./upload_queries.ts";

/** The queue that removes unused media. */
export const unusedMediaQueue = "media-cleanup";

/** The queue that removes files that media stopped using, once that change has committed. */
export const fileCleanupQueue = "media-files";

const FileCleanupJob = z.object({ keys: z.array(z.string()) });

/** How many uploads are removed at once. */
const removalBatch = 100;

/** The maximum number of batches one run removes, so that it ends well within its lease. */
const removalBatches = 100;

/**
 * Removes the file stored under `key`, unless media, a preview or an upload waiting to be processed
 * is stored under it. Run it after the change that stopped using the file has committed. It holds
 * the key's lock while it checks and removes, so nothing starts using the file in the meantime.
 */
export const deleteFileIfUnused = (ctx: Context, key: string): Promise<void> =>
    ctx.transaction(async (tx) => {
        await lockKey(tx.db, key);
        if (!await isFileUsed(tx, key)) await tx.files.delete(key);
    });

/**
 * Queues the removal of the files stored under `keys`, unless something uses them by then. Use it
 * when a transaction stops using files, because their removal must wait until it commits. Does
 * nothing for no keys.
 */
export const enqueueFileCleanup = async (
    ctx: Context,
    keys: readonly (string | null)[],
): Promise<void> => {
    const kept = [...new Set(keys)].filter((key) => key !== null);
    if (kept.length === 0) return;

    const payload: z.infer<typeof FileCleanupJob> = { keys: kept };
    await enqueue(ctx, { queue: fileCleanupQueue, payload });
};

/** Removes the files in the job that nothing uses. */
export const fileCleanupHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = FileCleanupJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a file cleanup job");

    for (const key of payload.data.keys) await deleteFileIfUnused(ctx, key);
};

/**
 * Removes uploads created at least as long ago as the settings say that nothing uses, along with
 * their files unless other uploads use them, in up to `batches` batches per run; the next run
 * removes the rest. The media of a deleted status can be attached again until then, so that the
 * status can be redrafted. Unused remote media is removed too, with the files it cached, like media
 * of deleted remote statuses or media removed by an edit.
 */
export const removeUnusedMedia = async (
    ctx: Context,
    batches = removalBatches,
): Promise<void> => {
    const before = new Date(ctx.clock.now().getTime() - ctx.settings.unattachedMs);

    let after: MediaCursor | undefined;
    for (let batch = 0; batch < batches; batch++) {
        const removed = await deleteUnusedMedia(ctx, before, after, removalBatch);
        const keys = new Set(
            removed.flatMap((row) => [row.sha256, row.preview_sha256, row.upload_sha256]),
        );

        for (const key of keys) if (key !== null) await deleteFileIfUnused(ctx, key);

        if (removed.length < removalBatch) return;
        after = removed.reduce((last, row) =>
            row.created_at > last.created_at ||
                (row.created_at.getTime() === last.created_at.getTime() && row.id > last.id)
                ? row
                : last
        );
    }
};
