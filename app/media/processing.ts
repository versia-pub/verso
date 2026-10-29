/**
 * Processing uploaded images: storing them upright, without metadata and no larger than allowed,
 * with a preview, or reusing what processing another upload of the same file stored. An image that
 * can't be processed is stored as nothing, as it may hold metadata.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { lockKey } from "../db/locking.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { bytesSource } from "../kernel/files.ts";
import type { Fit } from "../kernel/images.ts";
import { deleteFileIfUnused } from "./cleanup.ts";
import type { MediaProcessed } from "./events.ts";
import { findMedia, type MediaRow } from "./media_queries.ts";
import { finishUpload, type Processed, processedUpload } from "./upload_queries.ts";
import { keepUsed, MediaJob } from "./uploads.ts";

const logger = getLogger(["verso", "media"]);

/** The box the upload `row` is scaled down to fit in, if it has one. */
const fitOf = (row: MediaRow): Fit | undefined =>
    row.fit_width === null || row.fit_height === null
        ? undefined
        : { width: row.fit_width, height: row.fit_height };

/**
 * Marks the upload `id` as processed as `processed`, unless it already is, and tells the rest of
 * Verso. Returns whether it changed.
 */
const finishProcessing = async (tx: Context, id: string, processed: Processed) => {
    if (!await finishUpload(tx, id, processed)) return false;

    const event: MediaProcessed = {
        type: "media.processed",
        mediaId: id,
        stored: processed.sha256 !== null,
    };
    await emit(tx, event);
    return true;
};

/** What processing found, taken from another upload of the same file. */
const processedFrom = (row: MediaRow): Processed => ({
    sha256: row.sha256,
    size: row.size,
    media_type: row.media_type,
    width: row.width,
    height: row.height,
    thumbhash: row.thumbhash,
    blurhash: row.blurhash,
    preview_sha256: row.preview_sha256,
    preview_width: row.preview_width,
    preview_height: row.preview_height,
});

/** What an image that can't be processed is stored as: nothing, as it may hold metadata. */
const failed: Processed = { sha256: null, size: null, width: null, height: null };

/**
 * Marks the upload `id` as processed using another upload of the same file, `uploaded`, scaled down
 * to fit the same box `fit`, if there is one, and returns whether there was. Its files are locked
 * and checked to still be stored first, so that if they were removed in the meantime, this upload
 * is processed again rather than left pointing at nothing.
 */
const reuseProcessed = async (
    ctx: Context,
    id: string,
    uploaded: string,
    fit: Fit | undefined,
) => {
    const before = await processedUpload(ctx, uploaded, fit);
    if (before === undefined) return false;

    return await ctx.transaction(async (tx) => {
        for (const key of [before.sha256, before.preview_sha256]) {
            if (key === null) continue;

            await lockKey(tx.db, key);
            if (!await tx.files.has(key)) return false;
        }

        await finishProcessing(tx, id, processedFrom(before));
        return true;
    });
};

/**
 * Processes the image in the job: stores it upright, without metadata and no larger than allowed or
 * than its box, with a preview, then removes the original upload. An image that vips rejects, or
 * that still fails on the job's last attempt, is marked failed and removed, as it may hold
 * metadata. An upload that was already processed once keeps that result.
 */
export const mediaHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = MediaJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a media job");

    const row = await findMedia(ctx, payload.data.mediaId);
    if (row === undefined || row.upload_sha256 === null) return;
    const uploaded = row.upload_sha256;
    const fit = fitOf(row);

    // The other upload of the same file may also have removed the original, or left it for this
    // one. One that was already processed finds itself here, as a run that stopped after processing
    // it may have left the original.
    if (await reuseProcessed(ctx, row.id, uploaded, fit)) {
        return await deleteFileIfUnused(ctx, uploaded);
    }

    const stream = await ctx.files.get(uploaded);
    if (stream === undefined) throw new PermanentFailure(`The upload ${row.id} is gone`);

    let result: Awaited<ReturnType<Context["images"]["process"]>> | undefined;
    try {
        result = await ctx.images.process(stream, fit);
    } catch (error) {
        if (job.attempts < job.max_attempts) throw error;
        logger.warn("Couldn't process {id}, so it is removed: {error}", { id: row.id, error });
    }

    if (result?.ok !== true) {
        if (result) {
            logger.info("Removed {id}, as it is {reason}", { id: row.id, reason: result.reason });
        }

        await ctx.transaction((tx) => finishProcessing(tx, row.id, failed));
        return await deleteFileIfUnused(ctx, uploaded);
    }

    const { image } = result;
    const kept = await bytesSource(image.bytes);
    const preview = await bytesSource(image.preview.bytes);
    await ctx.files.put(kept, image.mediaType);
    await ctx.files.put(preview, image.preview.mediaType);

    const finished = await ctx.transaction(async (tx) => {
        await keepUsed(tx, kept, image.mediaType);
        await keepUsed(tx, preview, image.preview.mediaType);

        return await finishProcessing(tx, row.id, {
            sha256: kept.sha256,
            size: image.bytes.length,
            media_type: image.mediaType,
            width: image.width,
            height: image.height,
            thumbhash: image.thumbhash,
            blurhash: image.blurhash,
            preview_sha256: preview.sha256,
            preview_width: image.preview.width,
            preview_height: image.preview.height,
        });
    });

    // The original upload has its metadata, so it is removed. If another run got there first, what
    // this run stored may be unused.
    const unused = finished ? [uploaded] : [kept.sha256, preview.sha256];
    for (const key of unused) await deleteFileIfUnused(ctx, key);
};
