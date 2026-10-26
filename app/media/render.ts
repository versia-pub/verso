import type { MediaAttachment } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media_queries.ts";
import { isPlayable } from "./uploads.ts";

/** Where the local file kept under `key` is served: by the store, if it serves files, or Verso. */
export const fileUrl = (ctx: Context, key: string): string =>
    ctx.files.publicUrl?.(key) ?? ctx.urls.url`/media/${key}`;

/** A size as Mastodon describes it, if it is known. */
const dimensions = (width: number | null, height: number | null) =>
    width === null || height === null || width === 0 || height === 0
        ? undefined
        : { width, height, size: `${width}x${height}`, aspect: width / height };

/**
 * What kind of file Mastodon's clients are told it is. Local files that aren't pictures Verso
 * processed are kept as they were uploaded, so they are only offered as files, unless they can be
 * played.
 */
const typeOf = (row: MediaRow): MediaAttachment["type"] => {
    const local = row.instance_id === null;
    if (local && (row.processed_at === null || row.preview_sha256 !== null)) return "image";
    if (local && !isPlayable(row.media_type)) return "unknown";

    const [kind] = row.media_type.split("/");
    return kind === "image" || kind === "video" || kind === "audio" ? kind : "unknown";
};

/**
 * A file, as Mastodon's API describes it. A local one is at Verso's URL for it once processed;
 * another instance's is at its own.
 * @see https://docs.joinmastodon.org/entities/MediaAttachment/
 */
export const renderAttachment = (ctx: Context, row: MediaRow): MediaAttachment => {
    const local = row.instance_id === null;
    const ready = !local || row.processed_at !== null;
    const original = dimensions(row.width, row.height);
    const small = dimensions(row.preview_width, row.preview_height);
    const focus = row.focus_x === null || row.focus_y === null
        ? undefined
        : { x: row.focus_x, y: row.focus_y };

    return {
        id: row.id,
        type: typeOf(row),
        url: local ? (ready && row.sha256 ? fileUrl(ctx, row.sha256) : null) : row.url,
        preview_url: row.preview_sha256 ? fileUrl(ctx, row.preview_sha256) : null,
        // Local files have no URL of their own.
        remote_url: row.url,
        // A preview is only made of a picture whose size is known.
        meta: original || focus
            ? {
                ...original && { original },
                ...small && { small },
                ...focus && { focus },
            }
            : null,
        description: row.description,
        blurhash: row.blurhash,
    };
};
