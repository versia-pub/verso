import { z } from "zod";
import { contentFormatOf } from "./common.ts";

/**
 * A custom emoji, which text displays where it has its name, such as `:happy_face:`. The name is
 * letters, digits, `_` and `-`, between two characters that aren't.
 * @see https://versia.pub/extensions/custom-emojis
 */
export const CustomEmoji = z.object({
    name: z.string().regex(/^[^A-Za-z0-9_-][A-Za-z0-9_-]+[^A-Za-z0-9_-]$/u),
    content: contentFormatOf("image/"),
});
export type CustomEmoji = z.infer<typeof CustomEmoji>;

/** The key of {@link CustomEmojis} in an entity's `extensions`. */
export const customEmojisKey = "pub.versia:custom_emojis";

/**
 * The custom emojis an entity's text uses, in its `extensions` under {@link customEmojisKey}.
 * @see https://versia.pub/extensions/custom-emojis
 */
export const CustomEmojis = z.object({ emojis: z.array(CustomEmoji) });
export type CustomEmojis = z.infer<typeof CustomEmojis>;
