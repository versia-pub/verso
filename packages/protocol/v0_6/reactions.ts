import { z } from "zod";
import { Entity, ReferenceText } from "./common.ts";

/**
 * `author` reacts to the note `object` with `content`: an emoji, a custom emoji's name, or text.
 * @see https://versia.pub/extensions/reactions
 */
export const Reaction = Entity.extend({
    type: z.literal("pub.versia:reactions/Reaction"),
    author: ReferenceText,
    object: ReferenceText,
    content: z.string().min(1),
});
export type Reaction = z.infer<typeof Reaction>;
