/**
 * Media as Versia describes it, stored as Verso stores media.
 * @see https://versia.pub/structures/content-format
 * @module
 */
import { type v0_6, v0_7 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import type { MediaRow, RemoteMedia } from "./media_queries.ts";
import { fileUrl } from "./render.ts";
import { servedTypeOf } from "./serving.ts";
import { pictureTypes } from "./uploads.ts";

/** The longest URL Verso stores from a peer. */
export const maxUrlLength = 2048;
/** The longest media type Verso stores for remote media. */
const maxMediaTypeLength = 255;

/** The longest thumbhash Verso keeps. Real ones are at most about 40 characters. */
const maxThumbhashLength = 100;

/** The largest number Verso's integer columns hold. */
const maxInteger = 2 ** 31 - 1;

/** `value`, unless it is too large to store. The spec allows sizes and dimensions that large. */
const stored = (value: number | null | undefined) =>
    value !== null && value !== undefined && value <= maxInteger ? value : undefined;

/** What either version of Versia says about a file besides where it is and what type it is. */
type Details = {
    readonly size?: number | null;
    readonly hash?: string | null;
    readonly thumbhash?: string | null;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly description?: string | null;
};

/**
 * The media at `url`, as Verso stores it, or `null` if its URL or type is too long to store or
 * isn't a web URL. Numbers too large to store, or thumbhashes too long to be one, are left out.
 */
const storableMedia = (url: string, mediaType: string, details: Details): RemoteMedia | null => {
    if (mediaType.length > maxMediaTypeLength || url.length > maxUrlLength) return null;
    if (!v0_7.WebUrl.safeParse(url).success) return null;

    const { thumbhash } = details;
    return {
        url,
        mediaType,
        size: stored(details.size),
        sha256: details.hash?.toLowerCase(),
        width: stored(details.width),
        height: stored(details.height),
        thumbhash: thumbhash && thumbhash.length <= maxThumbhashLength ? thumbhash : undefined,
        description: details.description ?? undefined,
    };
};

/**
 * The first version of the media at a URL whose type `takes` accepts. Versions with a URL or type
 * too long to store are skipped, and numbers too large to store, or thumbhashes too long to be one,
 * are left out.
 */
const firstOf = (
    formats: v0_6.ContentFormat | null | undefined,
    takes: (mediaType: string) => boolean,
): RemoteMedia | null => {
    for (const [mediaType, entry] of Object.entries(formats ?? {})) {
        if (!entry.remote || !takes(mediaType)) continue;

        const media = storableMedia(entry.content, mediaType, entry);
        if (media !== null) return media;
    }

    return null;
};

/**
 * The media `media`, as Verso stores it, or `null` if there is none or `takes` doesn't accept its
 * type.
 */
export const remoteMedia = (
    media: v0_7.Media | null | undefined,
    takes: (mediaType: string) => boolean,
): RemoteMedia | null =>
    media && takes(media.media_type) ? storableMedia(media.url, media.media_type, media) : null;

/** The first version of an image at a URL that clients can display. */
export const remotePicture = (formats: v0_6.ContentFormat | null | undefined): RemoteMedia | null =>
    firstOf(formats, (mediaType) => pictureTypes.has(mediaType));

/** What a processed `row` tells Versia about its file, besides its URL and type. */
const detailsOf = (row: MediaRow) => ({
    description: row.description ?? undefined,
    size: row.size ?? undefined,
    hash: row.sha256 ?? undefined,
    thumbhash: row.thumbhash ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
});

/**
 * Local media as Versia describes it: at the URL it is served at, with the type it is served as.
 * Only the file is given, not its preview, which remote instances would take for another version of
 * it. Versia has no focus point to crop images around, so that is omitted. Media that isn't
 * processed yet, or isn't stored because processing failed, is `undefined`.
 */
export const versiaMedia = (ctx: Context, row: MediaRow): v0_7.Media | undefined => {
    if (row.processed_at === null || row.sha256 === null) return undefined;

    return { url: fileUrl(ctx, row.sha256), media_type: servedTypeOf(row), ...detailsOf(row) };
};
