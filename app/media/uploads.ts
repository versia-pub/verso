/**
 * Files people upload, to attach to their notes. Pictures are processed by a job, which keeps them
 * without their metadata and makes their previews; anything else, and any picture that can't be
 * processed, is kept as it was uploaded.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { lockKey } from "../db/locking.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { bytesSource, type FileSource } from "../kernel/files.ts";
import {
    formatHeadLength,
    type ImageFormat,
    imageFormatOf,
    imageFormats,
} from "../kernel/images.ts";
import { spool } from "../kernel/spool.ts";
import { findMedia, type MediaRow } from "./media_queries.ts";
import {
    deleteUnusedUploads,
    findUpload,
    finishUpload,
    insertUpload,
    isFileUsed,
    type Processed,
    processedUpload,
    updateUpload,
    type UploadCursor,
} from "./upload_queries.ts";

const logger = getLogger(["verso", "media"]);

/** The queue that processes uploaded pictures. */
export const mediaQueue = "media";

/** The queue that removes uploads no one attached. */
export const unusedUploadsQueue = "media-cleanup";

/** How long an upload may wait to be attached before it is removed, as on Mastodon. */
const unattachedMs = 24 * 60 * 60 * 1000;

/** How many uploads are removed at once. */
const removalBatch = 100;

/** How many batches one run removes at most, so it ends well within its lease. */
const removalBatches = 100;

const MediaJob = z.object({ mediaId: z.string() });

/** A file someone uploads. */
export type NewUpload = {
    readonly file: Blob;
    /** What their client says the file is, such as `application/zip`. */
    readonly mediaType: string;
    readonly description?: string;
    /** The point a picture's thumbnails are cropped around, from -1 to 1 on each axis. */
    readonly focus?: { readonly x: number; readonly y: number };
};

/**
 * The type a file is kept with, which the file store may serve it as. It comes from its bytes, not
 * from the client, so no one can upload a page or a script that Verso would serve as one.
 */
const keptTypeOf = (format: ImageFormat | undefined) =>
    format === undefined ? "application/octet-stream" : imageFormats[format].mediaType;

/** What a client says a file is, if it says it as a media type is written. */
const claimedTypeOf = (mediaType: string) =>
    /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType.toLowerCase() : "application/octet-stream";

/**
 * Makes sure `file`, which was kept before the transaction `tx`, is kept still, once it holds the
 * lock on its key, as removing an unused file holds it too: until `tx` commits, nothing that
 * finds it unused can remove it, and if something did before, it is kept again. Run it before
 * whatever in `tx` comes to use the file.
 */
const keepUsed = async (tx: Context, file: FileSource, mediaType: string) => {
    await lockKey(tx.db, file.sha256);
    if (!await tx.files.has(file.sha256)) await tx.files.put(file, mediaType);
};

/**
 * Keeps a file `accountId` uploads. A picture is processed by a job, and its row says it is being
 * processed until then; anything else is ready at once. The file is written to disk, and hashed,
 * as it is read, so it is held in memory only as the request has it.
 */
export const upload = async (
    ctx: Context,
    accountId: string,
    given: NewUpload,
): Promise<MediaRow> => {
    const head = await given.file.slice(0, formatHeadLength).bytes();
    const format = imageFormatOf(head);
    const type = keptTypeOf(format);

    await using file = await spool(given.file.stream());
    // Kept before the transaction, which mustn't wait on the store; `keepUsed` makes sure of it.
    await ctx.files.put(file, type);
    const now = ctx.clock.now();

    const row: MediaRow = {
        id: ctx.ids(),
        instance_id: null,
        url: null,
        media_type: format === undefined ? claimedTypeOf(given.mediaType) : type,
        size: file.size,
        sha256: file.sha256,
        width: null,
        height: null,
        thumbhash: null,
        description: given.description ?? null,
        created_at: now,
        account_id: accountId,
        upload_sha256: file.sha256,
        processed_at: format === undefined ? now : null,
        preview_sha256: null,
        preview_width: null,
        preview_height: null,
        blurhash: null,
        focus_x: given.focus?.x ?? null,
        focus_y: given.focus?.y ?? null,
    };

    await ctx.transaction(async (tx) => {
        await keepUsed(tx, file, type);
        await insertUpload(tx, row);
        if (format === undefined) return;

        const payload: z.infer<typeof MediaJob> = { mediaId: row.id };
        await enqueue(tx, { queue: mediaQueue, payload, maxAttempts: 3 });
    });

    return row;
};

/** How an upload is described: its alt text, and where its thumbnails are cropped around. */
export type UploadDescription = Pick<NewUpload, "description" | "focus">;

/**
 * Changes how the upload `id` is described, if `accountId` uploaded it, and returns it, or
 * `undefined` if they didn't. What is left out stays as it was; an empty description clears it.
 */
export const describeUpload = async (
    ctx: Context,
    accountId: string,
    id: string,
    changes: UploadDescription,
): Promise<MediaRow | undefined> => {
    const columns = {
        ...changes.description !== undefined && { description: changes.description || null },
        ...changes.focus && { focus_x: changes.focus.x, focus_y: changes.focus.y },
    };
    if (Object.keys(columns).length > 0) await updateUpload(ctx, id, accountId, columns);

    return await findUpload(ctx, id, accountId);
};

/**
 * Removes the file kept under `key`, unless a file, a preview or an upload waiting to be
 * processed is kept under it. Run it after the change that stopped using it has committed. It
 * holds the key's lock while it checks and removes, so nothing comes to use the file meanwhile.
 */
export const deleteFileIfUnused = (ctx: Context, key: string): Promise<void> =>
    ctx.transaction(async (tx) => {
        await lockKey(tx.db, key);
        if (!await isFileUsed(tx, key)) await tx.files.delete(key);
    });

/** What processing a file found, from another upload of the same file. */
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

/** What a picture that can't be processed is kept as: nothing, as it may hold metadata. */
const failed: Processed = { sha256: null, size: null, width: null, height: null };

/**
 * Whether an upload is a picture that couldn't be processed, which is neither served nor attached.
 * Uploads are kept under their SHA-256 until then.
 */
export const processingFailed = (upload: MediaRow): boolean => upload.sha256 === null;

/**
 * Marks the upload `id` processed as another upload of the same file, `uploaded`, was, if there is
 * one, and returns whether there was. Its files are locked and found still kept first, so that if
 * they were removed meanwhile, this one is processed anew rather than left pointing at nothing.
 */
const reuseProcessed = async (ctx: Context, id: string, uploaded: string) => {
    const before = await processedUpload(ctx, uploaded);
    if (before === undefined) return false;

    return await ctx.transaction(async (tx) => {
        for (const key of [before.sha256, before.preview_sha256]) {
            if (key === null) continue;

            await lockKey(tx.db, key);
            if (!await tx.files.has(key)) return false;
        }

        await finishUpload(tx, id, processedFrom(before));
        return true;
    });
};

/**
 * Processes the picture in the job: keeps it upright, without its metadata and no larger than
 * allowed, with a preview, then removes what was uploaded. One that vips refuses, or that still
 * fails on the job's last attempt, is marked failed and removed, as it may hold metadata. One
 * uploaded before is processed as it was then.
 */
export const mediaHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = MediaJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a media job");

    const row = await findMedia(ctx, payload.data.mediaId);
    if (row === undefined || row.upload_sha256 === null) return;
    const uploaded = row.upload_sha256;

    // The same file's other upload may also have removed what was uploaded, or left it for this.
    // One processed already finds itself, as a run that stopped after processing it may have
    // left what was uploaded.
    if (await reuseProcessed(ctx, row.id, uploaded)) return await deleteFileIfUnused(ctx, uploaded);

    const stream = await ctx.files.get(uploaded);
    if (stream === undefined) throw new PermanentFailure(`The upload ${row.id} is gone`);

    let result: Awaited<ReturnType<Context["images"]["process"]>> | undefined;
    try {
        result = await ctx.images.process(stream);
    } catch (error) {
        if (job.attempts < job.max_attempts) throw error;
        logger.warn("Couldn't process {id}, so it is removed: {error}", { id: row.id, error });
    }

    if (result?.ok !== true) {
        if (result) {
            logger.info("Removed {id}, as it is {reason}", { id: row.id, reason: result.reason });
        }

        await finishUpload(ctx, row.id, failed);
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

        return await finishUpload(tx, row.id, {
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

    // What was uploaded has its metadata, so it goes. If another run got there first, what this
    // one kept may be used by nothing.
    const unused = finished ? [uploaded] : [kept.sha256, preview.sha256];
    for (const key of unused) await deleteFileIfUnused(ctx, key);
};

/**
 * Removes the uploads made a day ago or more that nothing uses, with their files, unless other
 * uploads use them, up to `batches` batches in a run; the next run removes the rest.
 * The files of a note that is deleted can be attached again until a day after they were uploaded,
 * as Mastodon keeps them so that the note can be redrafted.
 */
export const removeUnusedUploads = async (
    ctx: Context,
    batches = removalBatches,
): Promise<void> => {
    const before = new Date(ctx.clock.now().getTime() - unattachedMs);

    let after: UploadCursor | undefined;
    for (let batch = 0; batch < batches; batch++) {
        const removed = await deleteUnusedUploads(ctx, before, after, removalBatch);
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
