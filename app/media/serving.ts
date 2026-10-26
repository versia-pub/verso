/**
 * Media stored by Verso, as served. Processed images are served as images, and video and audio as
 * the type they declare. Any other file is served as a download, so an uploaded page or script
 * never runs as one.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { imageFormats } from "../kernel/images.ts";
import type { MediaRow } from "./media_queries.ts";
import { findServedFile } from "./upload_queries.ts";
import { isPlayable } from "./uploads.ts";

/** A stored file, with the type it is served as, or the location where the file store serves it. */
export type ServedFile = { readonly location: string } | {
    readonly stream: ReadableStream<Uint8Array>;
    readonly mediaType: string;
    /** Whether browsers should download it rather than display it. */
    readonly download: boolean;
};

/**
 * The file stored under `key`, if a processed upload is stored as it, or has it as its preview. The
 * original upload of an image is never served, as it may hold metadata: it is only stored until
 * processing finishes.
 */
export const serveFile = async (ctx: Context, key: string): Promise<ServedFile | undefined> => {
    const row = await findServedFile(ctx, key);
    if (row === undefined) return undefined;

    const location = ctx.files.publicUrl?.(key);
    if (location !== undefined) return { location };

    const stream = await ctx.files.get(key);
    if (stream === undefined) return undefined;

    // Previews are always WebP.
    if (row.preview_sha256 === key) {
        return { stream, mediaType: imageFormats.webp.mediaType, download: false };
    }

    const mediaType = servedTypeOf(row);
    return { stream, mediaType, download: mediaType === "application/octet-stream" };
};

/**
 * The type a local file is served as: its own type if it is an image Verso processed or is
 * playable, otherwise `application/octet-stream`, so browsers download it.
 */
export const servedTypeOf = (row: Pick<MediaRow, "media_type" | "preview_sha256">): string =>
    row.preview_sha256 === null && !isPlayable(row.media_type)
        ? "application/octet-stream"
        : row.media_type;
