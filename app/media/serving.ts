/**
 * The files Verso keeps, as it serves them. Pictures it processed are served as pictures; any
 * other file is served for browsers to save, so an uploaded page or script never runs as one.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { imageFormats } from "../kernel/images.ts";
import { findServedFile } from "./upload_queries.ts";

/** A kept file, with the type it is served as, or where the store serves it. */
export type ServedFile = { readonly location: string } | {
    readonly stream: ReadableStream<Uint8Array>;
    readonly mediaType: string;
    /** Whether browsers should save it rather than show it. */
    readonly download: boolean;
};

/**
 * The file kept under `key`, if an upload that is processed is kept as it, or has it as its
 * preview. What was uploaded of a picture is never served, as it may hold metadata: it is only kept
 * until it is processed.
 */
export const serveFile = async (ctx: Context, key: string): Promise<ServedFile | undefined> => {
    const row = await findServedFile(ctx, key);
    if (row === undefined) return undefined;

    const location = ctx.files.publicUrl?.(key);
    if (location !== undefined) return { location };

    const stream = await ctx.files.get(key);
    if (stream === undefined) return undefined;

    // Previews are always made as WebP.
    if (row.preview_sha256 === key) {
        return { stream, mediaType: imageFormats.webp.mediaType, download: false };
    }

    return row.preview_sha256 === null
        ? { stream, mediaType: "application/octet-stream", download: true }
        : { stream, mediaType: row.media_type, download: false };
};
