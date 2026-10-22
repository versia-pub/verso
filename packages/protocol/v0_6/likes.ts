import { z } from "zod";
import { Entity, ReferenceText } from "./common.ts";

/**
 * `author` likes the note `liked`. A user can't like and dislike the same note; each replaces the
 * other.
 * @see https://versia.pub/extensions/likes
 */
export const Like = Entity.extend({
    type: z.literal("pub.versia:likes/Like"),
    author: ReferenceText,
    liked: ReferenceText,
});
export type Like = z.infer<typeof Like>;

/**
 * `author` dislikes the note `disliked`.
 * @see https://versia.pub/extensions/likes
 */
export const Dislike = Entity.extend({
    type: z.literal("pub.versia:likes/Dislike"),
    author: ReferenceText,
    disliked: ReferenceText,
});
export type Dislike = z.infer<typeof Dislike>;
