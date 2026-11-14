import { z } from "zod";
import { Entity, ReferenceText } from "./common.ts";

/** The fields of an interaction with the Note `target`. */
const Interaction = Entity.extend({
    author: ReferenceText,
    target: ReferenceText,
});

/**
 * `author` likes the Note `target`.
 * @see https://versia.pub/extensions/likes
 */
export const Like = Interaction.extend({ type: z.literal("pub.versia:likes/Like") });
export type Like = z.infer<typeof Like>;

/**
 * `author` dislikes the Note `target`.
 * @see https://versia.pub/extensions/likes
 */
export const Dislike = Interaction.extend({ type: z.literal("pub.versia:likes/Dislike") });
export type Dislike = z.infer<typeof Dislike>;

/**
 * `author` shares (boosts) the Note `target` with their subscribers.
 * @see https://versia.pub/extensions/share
 */
export const Share = Interaction.extend({ type: z.literal("pub.versia:share/Share") });
export type Share = z.infer<typeof Share>;

/**
 * `author` reacts to the Note `target` with `content`: an emoji, a custom emoji's name, or text.
 * @see https://versia.pub/extensions/reactions
 */
export const Reaction = Interaction.extend({
    type: z.literal("pub.versia:reactions/Reaction"),
    content: z.string().min(1),
});
export type Reaction = z.infer<typeof Reaction>;
