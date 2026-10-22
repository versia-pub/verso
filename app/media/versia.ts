/**
 * Files as Versia describes them, as Verso keeps them.
 * @see https://versia.pub/structures/content-format
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { RemoteMedia } from "./media.ts";

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
