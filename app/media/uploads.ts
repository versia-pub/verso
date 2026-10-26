/**
 * Media uploaded by users, to attach to their statuses or as their avatars and headers. Images are
 * processed by a job, which stores them without metadata and generates previews. Anything else, and
 * any image that can't be processed, is stored as uploaded.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { lockKey } from "../db/locking.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { bytesSource, type FileSource } from "../kernel/files.ts";
import {
    type Fit,
    formatHeadLength,
    type ImageFormat,
    imageFormatOf,
    imageFormats,
} from "../kernel/images.ts";
import { spool } from "../kernel/spool.ts";
import type { MediaProcessed } from "./events.ts";
import { findMedia, type MediaRow } from "./media_queries.ts";
import {
    deleteUnusedMedia,
    findUpload,
    finishUpload,
    insertUpload,
    isFileUsed,
    type MediaCursor,
    type Processed,
    processedUpload,
    updateUpload,
} from "./upload_queries.ts";

const logger = getLogger(["verso", "media"]);

/** The queue that processes uploaded images. */
export const mediaQueue = "media";

/** The queue that removes unused media. */
export const unusedMediaQueue = "media-cleanup";

/** How many uploads are removed at once. */
const removalBatch = 100;

/** The maximum number of batches one run removes, so that it ends well within its lease. */
const removalBatches = 100;

const MediaJob = z.object({ mediaId: z.string() });

/** A file being uploaded. */
export type NewUpload = {
    readonly file: Blob;
    /** The media type the client says the file has, such as `application/zip`. */
    readonly mediaType: string;
    readonly description?: string;
    /** The point an image's thumbnails are cropped around, from -1 to 1 on each axis. */
    readonly focus?: { readonly x: number; readonly y: number };
};

/**
 * The video and audio types a file is served as when its client declares one of them. Mastodon
 * accepts these too, so clients can play the file. Verso doesn't inspect the contents, so a file
 * that isn't what it declares is still served that way, but never as a page, because responses tell
 * browsers not to sniff types.
 * @see https://github.com/mastodon/mastodon/blob/v4.3.0/app/models/media_attachment.rb
 */
const playableTypes = new Set([
    "video/webm",
    "video/mp4",
    "video/quicktime",
    "video/ogg",
    "audio/wave",
    "audio/wav",
    "audio/x-wav",
    "audio/x-pn-wave",
    "audio/vnd.wave",
    "audio/ogg",
    "audio/vorbis",
    "audio/mpeg",
    "audio/mp3",
    "audio/webm",
    "audio/flac",
    "audio/aac",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mp4",
    "audio/3gpp",
]);

/**
 * Whether a file that Verso stores as uploaded, with the type `mediaType`, is served as that type.
 */
export const isPlayable = (mediaType: string): boolean => playableTypes.has(mediaType);

/**
 * The type a file is stored with, which the file store may serve it as. An image's type comes from
 * its bytes. Any other file gets the client's declared type only if it is playable, so no one can
 * upload a page or script that Verso would serve as one.
 */
const keptTypeOf = (format: ImageFormat | undefined, claimed: string) =>
    format === undefined
        ? isPlayable(claimed) ? claimed : "application/octet-stream"
        : imageFormats[format].mediaType;

/** The type a client declares for a file, if it is a well-formed media type. */
const claimedTypeOf = (mediaType: string) =>
    /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType.toLowerCase() : "application/octet-stream";

/**
 * Ensures that `file`, which was stored before the transaction `tx`, is still stored, by taking the
 * lock on its key. Removal of unused files takes the same lock, so until `tx` commits nothing that
 * finds the file unused can remove it, and if something already did, it is stored again. Run it
 * before anything in `tx` that starts using the file.
 */
const keepUsed = async (tx: Context, file: FileSource, mediaType: string) => {
    await lockKey(tx.db, file.sha256);
    if (!await tx.files.has(file.sha256)) await tx.files.put(file, mediaType);
};

/** The image format of `file`, from its first bytes, or `undefined` if it isn't an image. */
const formatOf = async (file: Blob) => imageFormatOf(await file.slice(0, formatHeadLength).bytes());

/**
 * Stores a file uploaded by `accountId`, in the image format `format` if it is an image, which is
 * scaled down to fit in `fit` if given.
 */
const store = async (
    ctx: Context,
    accountId: string,
    given: NewUpload,
    format: ImageFormat | undefined,
    fit?: Fit,
): Promise<MediaRow> => {
    const claimed = claimedTypeOf(given.mediaType);
    const type = keptTypeOf(format, claimed);

    await using file = await spool(given.file.stream());
    // Stored before the transaction, which mustn't wait on the file store; `keepUsed` ensures it is
    // still stored.
    await ctx.files.put(file, type);
    const now = ctx.clock.now();

    const row: MediaRow = {
        id: ctx.ids(),
        instance_id: null,
        url: null,
        media_type: format === undefined ? claimed : type,
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
        fit_width: fit?.width ?? null,
        fit_height: fit?.height ?? null,
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

/**
 * Stores a file uploaded by `accountId`. An image is processed by a job, and its row says it is
 * being processed until then; anything else is ready immediately. The file is written to disk and
 * hashed as it is read, so only what the request has buffered is held in memory.
 */
export const upload = async (
    ctx: Context,
    accountId: string,
    given: NewUpload,
): Promise<MediaRow> => await store(ctx, accountId, given, await formatOf(given.file));

/**
 * Stores an image uploaded by `accountId`, such as an avatar, to be scaled down to fit in `fit` as
 * it is processed, as `upload` does. Returns `undefined`, storing nothing, if it isn't an image.
 */
export const uploadPicture = async (
    ctx: Context,
    accountId: string,
    given: NewUpload,
    fit: Fit,
): Promise<MediaRow | undefined> => {
    const format = await formatOf(given.file);
    return format && await store(ctx, accountId, given, format, fit);
};

/** The box the upload `row` is scaled down to fit in, if it has one. */
const fitOf = (row: MediaRow): Fit | undefined =>
    row.fit_width === null || row.fit_height === null
        ? undefined
        : { width: row.fit_width, height: row.fit_height };

/** How an upload is described: its alt text, and the point its thumbnails are cropped around. */
export type UploadDescription = Pick<NewUpload, "description" | "focus">;

/**
 * Updates the description of the upload `id` if `accountId` uploaded it, and returns it, or
 * `undefined` if they didn't. Fields that are omitted stay unchanged; an empty description clears
 * it.
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
 * Whether an upload is an image that couldn't be processed, which is neither served nor attached.
 * Until then, uploads are stored under their SHA-256.
 */
export const processingFailed = (upload: MediaRow): boolean => upload.sha256 === null;

/**
 * Marks the upload `id` as processed using another upload of the same file, `uploaded`, scaled down
 * to fit the same box `fit`, if there is one, and returns whether there was. Its files are locked and checked to still be stored first, so
 * that if they were removed in the meantime, this upload is processed again rather than left
 * pointing at nothing.
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
 * than its box, with a preview, then removes the original upload. An image that vips rejects, or that still fails
 * on the job's last attempt, is marked failed and removed, as it may hold metadata. An upload that
 * was already processed once keeps that result.
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
