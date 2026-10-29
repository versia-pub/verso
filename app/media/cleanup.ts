/**
 * Removing what nothing uses: media, local or remote, that no status, account or emoji used within
 * the time the settings give, and the files that no media uses.
 * @module
 */
import { lockKey } from "../db/locking.ts";
import type { Context } from "../kernel/context.ts";
import { deleteUnusedMedia, isFileUsed, type MediaCursor } from "./upload_queries.ts";

/** The queue that removes unused media. */
export const unusedMediaQueue = "media-cleanup";

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
 * Removes uploads created at least as long ago as the settings say that nothing uses, along with
 * their files unless other uploads use them, in up to `batches` batches per run; the next run
 * removes the rest. The media of a deleted status can be attached again until then, as Mastodon
 * keeps it so the status can be redrafted. Unused remote media is removed too, such as media of
 * deleted remote statuses or removed by an edit; Verso stores only the rows for remote media.
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
            removed.filter((row) => row.instance_id === null)
                .flatMap((row) => [row.sha256, row.preview_sha256, row.upload_sha256]),
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
