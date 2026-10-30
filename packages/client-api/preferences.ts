import { z } from "zod";
import { Visibility } from "./account.ts";

/**
 * Preferences defined by the user in their account settings, for clients to share.
 * @see https://docs.joinmastodon.org/entities/Preferences/
 */
export const Preferences = z.object({
    /** Default visibility for new posts. */
    "posting:default:visibility": Visibility,
    /** Default sensitivity flag for new posts. */
    "posting:default:sensitive": z.boolean(),
    /** Default language for new posts, as an ISO 639-1 code, or `null` for none. */
    "posting:default:language": z.string().nullable(),
    /** Who may quote new posts. */
    "posting:default:quote_policy": z.enum(["public", "followers", "nobody"]),
    /** Default for adding a content warning for new posts. */
    "posting:default:spoiler_field": z.boolean(),
    /**
     * Whether media attachments should be automatically displayed or blurred/hidden: hidden only if
     * marked sensitive by `default`, always shown by `show_all`, or always hidden by `hide_all`.
     */
    "reading:expand:media": z.enum(["default", "show_all", "hide_all"]),
    /** Whether CWs should be expanded by default. */
    "reading:expand:spoilers": z.boolean(),
    /** Whether animated GIFs play on their own. */
    "reading:autoplay:gifs": z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;
