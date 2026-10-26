import { z } from "zod";

/**
 * A custom emoji that can be used in text as `:shortcode:`.
 * @see https://docs.joinmastodon.org/entities/CustomEmoji/
 */
export const CustomEmoji = z.object({
    shortcode: z.string(),
    url: z.url(),
    /** The same picture, not animated. */
    static_url: z.url(),
    /** Whether the emoji picker displays it, rather than only accepting it when typed. */
    visible_in_picker: z.boolean(),
    /** The picker's group for it, or `null` for none. */
    category: z.string().nullable(),
});
export type CustomEmoji = z.infer<typeof CustomEmoji>;
