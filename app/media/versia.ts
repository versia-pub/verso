/**
 * Media as Versia describes it, stored as Verso stores media.
 * @see https://versia.pub/structures/content-format
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import type { MediaRow, RemoteMedia } from "./media_queries.ts";
import { fileUrl } from "./render.ts";
import { servedTypeOf } from "./serving.ts";
import { isPlayable } from "./uploads.ts";

/** Image types clients can be counted on to display. */
const pictureTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The first version of the media at a URL whose type `takes` accepts. */
const firstOf = (
    formats: v0_6.ContentFormat | null | undefined,
    takes: (mediaType: string) => boolean,
): RemoteMedia | null => {
    for (const [mediaType, entry] of Object.entries(formats ?? {})) {
        if (!entry.remote || !takes(mediaType)) continue;
        if (!v0_6.WebUrl.safeParse(entry.content).success) continue;

        return {
            url: entry.content,
            mediaType,
            size: entry.size ?? undefined,
            sha256: entry.hash?.toLowerCase(),
            width: entry.width ?? undefined,
            height: entry.height ?? undefined,
            thumbhash: entry.thumbhash ?? undefined,
            description: entry.description ?? undefined,
        };
    }

    return null;
};

/** The first version of an image at a URL that clients can display. */
export const remotePicture = (formats: v0_6.ContentFormat | null | undefined): RemoteMedia | null =>
    firstOf(formats, (mediaType) => pictureTypes.has(mediaType));

/**
 * The first version of the media at a URL that clients can display as an image, otherwise play,
 * otherwise any.
 */
export const remoteFile = (formats: v0_6.ContentFormat): RemoteMedia | null =>
    remotePicture(formats) ?? firstOf(formats, isPlayable) ?? firstOf(formats, () => true);

/**
 * Local media as Versia describes it: at the URL it is served at, with the type it is served as.
 * Only the file is given, not its preview, which remote instances would take for another version of
 * it. Versia has no focus point to crop images around, so that is omitted. Media that isn't stored
 * because processing failed is `undefined`.
 */
export const versiaFile = (ctx: Context, row: MediaRow): v0_6.ContentFormat | undefined => {
    if (row.sha256 === null) return undefined;

    return {
        [servedTypeOf(row)]: {
            content: fileUrl(ctx, row.sha256),
            remote: true,
            description: row.description ?? undefined,
            size: row.size ?? undefined,
            hash: row.sha256,
            thumbhash: row.thumbhash ?? undefined,
            width: row.width ?? undefined,
            height: row.height ?? undefined,
        },
    };
};
