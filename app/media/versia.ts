/**
 * Files as Versia describes them, as Verso keeps them.
 * @see https://versia.pub/structures/content-format
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import type { MediaRow, RemoteMedia } from "./media_queries.ts";
import { fileUrl } from "./render.ts";
import { servedTypeOf } from "./serving.ts";

/** Pictures clients can be counted on to show. */
const pictureTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The first version of a picture that clients can show, at a web address. */
export const remotePicture = (
    formats: v0_6.ContentFormat | null | undefined,
): RemoteMedia | null => {
    for (const [mediaType, entry] of Object.entries(formats ?? {})) {
        if (!entry.remote || !pictureTypes.has(mediaType)) continue;
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

/**
 * A local file, as Versia describes it: at the URL it is served at, as the type it is served as.
 * Only the file is given, not its preview, which other instances would take for another version of
 * it. Versia has no point to crop pictures around, so that is left out. A file that isn't kept, as
 * processing it failed, is `undefined`.
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
