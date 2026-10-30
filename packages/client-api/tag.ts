import { z } from "zod";

/**
 * How a hashtag was used on one day.
 * @see https://docs.joinmastodon.org/entities/Tag/#history
 */
export const TagHistory = z.object({
    /** Midnight at the start of the day, in UTC, as a UNIX timestamp. */
    day: z.string(),
    /** How many statuses used it that day. */
    uses: z.string(),
    /** How many accounts those statuses were by. */
    accounts: z.string(),
});
export type TagHistory = z.infer<typeof TagHistory>;

/**
 * A hashtag, with how it was used lately.
 * @see https://docs.joinmastodon.org/entities/Tag/
 */
export const Tag = z.object({
    id: z.string(),
    /** Without the `#`. */
    name: z.string(),
    /** The hashtag's page. */
    url: z.url(),
    /** Each of the past week's days, today first. */
    history: z.array(TagHistory),
});
export type Tag = z.infer<typeof Tag>;

/**
 * A hashtag an account features on its profile.
 * @see https://docs.joinmastodon.org/entities/FeaturedTag/
 */
export const FeaturedTag = z.object({
    id: z.string(),
    /** Without the `#`. */
    name: z.string(),
    /** The page of the account's statuses with the hashtag. */
    url: z.url(),
    /** How many of the account's statuses have it, as a string. */
    statuses_count: z.string(),
    /** The day the latest of them was posted, or `null` if there are none. */
    last_status_at: z.iso.date().nullable(),
});
export type FeaturedTag = z.infer<typeof FeaturedTag>;
