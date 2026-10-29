/**
 * Media uploaded by users, to attach to their statuses or as their avatars and headers, and their
 * descriptions. Images are processed by a job, which stores them without metadata and generates
 * previews. Anything else is stored as uploaded.
 * @module
 */
import { z } from "zod";
import { lockKey } from "../db/locking.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { FileSource } from "../kernel/files.ts";
import {
    type Fit,
    formatHeadLength,
    type ImageFormat,
    imageFormatOf,
    imageFormats,
} from "../kernel/images.ts";
import { spool } from "../kernel/spool.ts";
import type { MediaRow } from "./media_queries.ts";
import { findUpload, insertUpload, updateUpload } from "./upload_queries.ts";

/** The queue that processes uploaded images. */
export const mediaQueue = "media";

/** What a media job processes. */
export const MediaJob = z.object({ mediaId: z.string() });

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
export const keepUsed = async (
    tx: Context,
    file: FileSource,
    mediaType: string,
): Promise<void> => {
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
 * Whether an upload is an image that couldn't be processed, which is neither served nor attached.
 * Until then, uploads are stored under their SHA-256.
 */
export const processingFailed = (upload: MediaRow): boolean => upload.sha256 === null;
