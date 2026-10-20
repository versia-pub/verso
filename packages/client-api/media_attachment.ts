import { z } from "zod";

/** The size of a picture or video, or of its preview. */
const Dimensions = z.object({
    width: z.int().min(0),
    height: z.int().min(0),
    /** Such as `640x480`. */
    size: z.string(),
    /** Width over height. */
    aspect: z.number(),
});

/**
 * A file attached to a status, such as a picture.
 * @see https://docs.joinmastodon.org/entities/MediaAttachment/
 */
export const MediaAttachment = z.object({
    id: z.string(),
    type: z.enum(["unknown", "image", "gifv", "video", "audio"]),
    /** `null` while the file is still being processed. */
    url: z.url().nullable(),
    /** A smaller version, or `null` if there is none. */
    preview_url: z.url().nullable(),
    /** Where the file is on its own instance, or `null` if it is local. */
    remote_url: z.url().nullable(),
    /** What is known of the file, such as its size, or `null` if nothing is. */
    meta: z.object({
        original: Dimensions.partial().optional(),
        small: Dimensions.partial().optional(),
        /** The point thumbnails are cropped around, from -1 to 1 on each axis. */
        focus: z.object({ x: z.number(), y: z.number() }).optional(),
    }).nullable(),
    /** Alt text, or `null` if there is none. */
    description: z.string().nullable(),
    /** A placeholder to show while the file loads, or `null` if there is none. */
    blurhash: z.string().nullable(),
});
export type MediaAttachment = z.infer<typeof MediaAttachment>;
