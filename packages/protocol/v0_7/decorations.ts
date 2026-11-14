import { z } from "zod";
import { mediaOf, optional } from "./common.ts";

/** The key of {@link Decorations} in a User's `extensions`. */
export const decorationsKey = "pub.versia:decorations";

/**
 * How a user's profile looks, in its `extensions` under {@link decorationsKey}. The first of
 * `avatar_overlays` is drawn on top.
 * @see https://versia.pub/extensions/decorations
 */
export const Decorations = z.object({
    header: optional(mediaOf("image/")),
    avatar_overlays: optional(z.array(mediaOf("image/"))),
    avatar_mask: optional(mediaOf("image/")),
    background: optional(mediaOf("image/")),
    audio: optional(mediaOf("audio/")),
});
export type Decorations = z.infer<typeof Decorations>;
