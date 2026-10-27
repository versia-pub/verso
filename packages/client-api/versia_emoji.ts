import { z } from "zod";
import { CustomEmoji } from "./custom_emoji.ts";

/**
 * A custom emoji as Versia's emoji endpoints render it, with its id, whether it is global, and its
 * alt text. Versia Server's extension to the Mastodon API. Its picture's URLs are `null`
 * while the picture is processed, as Verso processes pictures after they are uploaded.
 * @see https://github.com/versia-pub/server/blob/main/packages/client/schemas/emoji.ts
 */
export const VersiaEmoji = CustomEmoji.extend({
    id: z.string(),
    url: z.url().nullable(),
    static_url: z.url().nullable(),
    /** Whether it is a global emoji, rather than the own emoji of the user who added it. */
    global: z.boolean(),
    /** Its alt text, or `null` for none. */
    description: z.string().nullable(),
});
export type VersiaEmoji = z.infer<typeof VersiaEmoji>;
