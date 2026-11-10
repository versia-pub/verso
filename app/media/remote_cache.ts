/**
 * Caching remote media: a job fetches the file of each remote image, video or audio when Verso
 * receives it, checks it against the hash its instance gave, and stores it as uploads are stored,
 * so that Verso can serve it and clients needn't reach other instances. Images are processed as
 * uploads are, to store them without metadata; video and audio are stored as fetched.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { bytesSource, type FileSource } from "../kernel/files.ts";
import { formatHeadLength, imageFormatOf } from "../kernel/images.ts";
import { domainOf } from "../instances/instance_queries.ts";
import { fetchLimited } from "../kernel/web_fetch.ts";
import { deleteFileIfUnused, enqueueFileCleanup } from "./cleanup.ts";
import {
    deleteMediaAmong,
    findMedia,
    type MediaRow,
    type RemoteMedia,
    storeRemoteMedia,
} from "./media_queries.ts";
import { finishCaching } from "./upload_queries.ts";
import { isCacheable, keepUsed, pictureTypes } from "./uploads.ts";

const logger = getLogger(["verso", "media"]);

/** The queue that caches remote media, grouped by the host the file is fetched from. */
export const remoteMediaQueue = "remote-media";

const CacheJob = z.object({ mediaId: z.string(), url: z.string() });

/** The largest video or audio file that is cached, as on Mastodon. */
const playableBytes = 99 * 1024 * 1024;

/**
 * Stores remote media for the instance `instanceId`, as {@link storeRemoteMedia} does, and queues
 * caching its file, if it is cached, and the removal of the cached files it stopped using. Returns
 * its id.
 */
export const saveRemoteMedia = async (
    ctx: Context,
    instanceId: string,
    current: string | null,
    media: RemoteMedia,
): Promise<string> => {
    const saved = await storeRemoteMedia(ctx, instanceId, current, media);
    if (saved.uncached && ctx.settings.cacheRemoteMedia && isCacheable(media.mediaType)) {
        const payload: z.infer<typeof CacheJob> = { mediaId: saved.id, url: media.url };
        await enqueue(ctx, {
            queue: remoteMediaQueue,
            payload,
            maxAttempts: 3,
            dedupeKey: `${remoteMediaQueue}:${saved.id}:${media.url}`,
            group: new URL(media.url).host,
        });
    }
    await enqueueFileCleanup(ctx, saved.unused);

    return saved.id;
};

/**
 * Deletes the remote media `ids`, which nothing may reference any more, and queues the removal of
 * the files it cached.
 */
export const deleteRemoteMedia = async (ctx: Context, ids: readonly string[]): Promise<void> => {
    await enqueueFileCleanup(ctx, await deleteMediaAmong(ctx, ids));
};

/** What caching stores for remote media: its files, and what they are. */
type Cached = {
    readonly files: readonly { readonly file: FileSource; readonly mediaType: string }[];
    readonly columns: Parameters<typeof finishCaching>[3];
};

/** Why remote media wasn't cached: for good, or for now, to be tried again. */
type NotCached = "failed" | "retry";

/** The image `bytes` processed and stored, as an upload's is. */
const cachedImage = async (
    ctx: Context,
    row: MediaRow,
    bytes: Uint8Array<ArrayBuffer>,
    lastAttempt: boolean,
): Promise<Cached | NotCached> => {
    const format = imageFormatOf(bytes.subarray(0, formatHeadLength));
    if (format === undefined) return "failed";

    let result: Awaited<ReturnType<Context["images"]["process"]>>;
    try {
        result = await ctx.images.process(ReadableStream.from([bytes]));
    } catch (error) {
        if (!lastAttempt) return "retry";
        logger.warn("Couldn't process {id}, so it isn't cached: {error}", { id: row.id, error });
        return "failed";
    }
    if (!result.ok) return "failed";

    const { image } = result;
    const kept = await bytesSource(image.bytes);
    const preview = await bytesSource(image.preview.bytes);
    await ctx.files.put(kept, image.mediaType);
    await ctx.files.put(preview, image.preview.mediaType);

    return {
        files: [
            { file: kept, mediaType: image.mediaType },
            { file: preview, mediaType: image.preview.mediaType },
        ],
        columns: {
            sha256: kept.sha256,
            cached_type: image.mediaType,
            size: image.bytes.length,
            width: image.width,
            height: image.height,
            thumbhash: row.thumbhash ?? image.thumbhash,
            blurhash: image.blurhash,
            preview_sha256: preview.sha256,
            preview_width: image.preview.width,
            preview_height: image.preview.height,
        },
    };
};

/** The video or audio `bytes` stored as fetched. */
const cachedPlayable = async (
    ctx: Context,
    row: MediaRow,
    bytes: Uint8Array<ArrayBuffer>,
): Promise<Cached> => {
    const file = await bytesSource(bytes);
    await ctx.files.put(file, row.media_type);

    return {
        files: [{ file, mediaType: row.media_type }],
        columns: { sha256: file.sha256, cached_type: row.media_type, size: bytes.length },
    };
};

/**
 * Fetches and stores the file of the remote media `row`. It isn't cached if it can't be fetched by
 * the last attempt, is larger than allowed, doesn't match the hash its instance gave, or is an
 * image that can't be processed.
 */
const cache = async (
    ctx: Context,
    row: MediaRow & { url: string },
    lastAttempt: boolean,
): Promise<Cached | NotCached> => {
    const picture = pictureTypes.has(row.media_type);
    const fetched = await fetchLimited(ctx, new URL(row.url), {
        accept: picture ? "image/*" : row.media_type,
        // What it is is told by its bytes, or else by what its instance said.
        approves: () => true,
        limit: picture ? ctx.settings.maxUploadBytes : playableBytes,
    });
    if (fetched === undefined) return lastAttempt ? "failed" : "retry";
    if (fetched.truncated) return "failed";

    const { body } = fetched;
    if (row.remote_sha256 !== null && (await bytesSource(body)).sha256 !== row.remote_sha256) {
        logger.info("Didn't cache {id}, as it doesn't match its hash", { id: row.id });
        return "failed";
    }

    return picture
        ? await cachedImage(ctx, row, body, lastAttempt)
        : await cachedPlayable(ctx, row, body);
};

/**
 * Fetches and stores the file of the remote media `row` now, unless its instance or the host of its
 * file is blocked. Media that can't be cached is marked so, and isn't tried again, unless fetching
 * failed only for now; then it is left uncached, and this is `"retry"`.
 */
export const cacheNow = async (
    ctx: Context,
    row: MediaRow & { instance_id: string; url: string },
    lastAttempt: boolean,
): Promise<"done" | "retry"> => {
    // Nothing is fetched from blocked instances, and there is nothing more to do. The media stays
    // uncached, should they be unblocked.
    const instance = await domainOf(ctx, row.instance_id);
    for (const domain of [instance, new URL(row.url).hostname]) {
        if (domain !== undefined && await ctx.federation.isBlocked(ctx, domain)) return "done";
    }

    const cached = await cache(ctx, row, lastAttempt);
    if (cached === "retry") return "retry";

    const finished = await ctx.transaction(async (tx) => {
        if (cached === "failed") return await finishCaching(tx, row.id, row.url, {});

        for (const { file, mediaType } of cached.files) await keepUsed(tx, file, mediaType);
        return await finishCaching(tx, row.id, row.url, cached.columns);
    });

    // If the media changed or was cached meanwhile, what this run stored may be unused.
    if (!finished && cached !== "failed") {
        for (const { file } of cached.files) await deleteFileIfUnused(ctx, file.sha256);
    }

    return "done";
};

/**
 * Caches the remote media in the job, as {@link cacheNow} does, unless it was cached already, or
 * its URL changed, which queues caching the new one.
 */
export const remoteMediaHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = CacheJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a remote media job");

    const { mediaId, url } = payload.data;
    const row = await findMedia(ctx, mediaId);
    if (row === undefined || row.instance_id === null || row.processed_at !== null) return;
    if (row.url !== url) return;

    const outcome = await cacheNow(
        ctx,
        { ...row, instance_id: row.instance_id, url },
        job.attempts >= job.max_attempts,
    );
    if (outcome === "retry") throw new Error(`Couldn't cache ${mediaId} yet`);
};
