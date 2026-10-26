import type { MediaAttachment } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media_queries.ts";
import { isPlayable } from "./uploads.ts";

/**
 * Where the local file stored under `key` is served: by the file store if it serves files,
 * otherwise by Verso.
 */
export const fileUrl = (ctx: Context, key: string): string =>
    ctx.files.publicUrl?.(key) ?? ctx.urls.url`/media/${key}`;

/** A size as Mastodon renders it, if known. */
const dimensions = (width: number | null, height: number | null) =>
    width === null || height === null || width === 0 || height === 0
        ? undefined
        : { width, height, size: `${width}x${height}`, aspect: width / height };

/**
 * The media type that Mastodon clients are told. Local media that isn't an image Verso processed is
 * stored as uploaded, so it is only offered as a generic file unless it is playable.
 */
const typeOf = (row: MediaRow): MediaAttachment["type"] => {
    const local = row.instance_id === null;
    if (local && (row.processed_at === null || row.preview_sha256 !== null)) return "image";
    if (local && !isPlayable(row.media_type)) return "unknown";

    const [kind] = row.media_type.split("/");
    return kind === "image" || kind === "video" || kind === "audio" ? kind : "unknown";
};

/**
 * Media as Mastodon's API renders it. Local media is served at Verso's URL once processed; remote
 * media is served at the remote instance's URL.
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
        // Local media has no remote URL.
        remote_url: row.url,
        // A preview is only made for an image whose size is known.
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
