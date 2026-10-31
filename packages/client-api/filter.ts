import { z } from "zod";

/**
 * A keyword a filter matches statuses by.
 * @see https://docs.joinmastodon.org/entities/FilterKeyword/
 */
export const FilterKeyword = z.object({
    id: z.string(),
    keyword: z.string(),
    /** Whether it matches only at word boundaries. */
    whole_word: z.boolean(),
});
export type FilterKeyword = z.infer<typeof FilterKeyword>;

/**
 * A status a filter matches.
 * @see https://docs.joinmastodon.org/entities/FilterStatus/
 */
export const FilterStatus = z.object({
    id: z.string(),
    status_id: z.string(),
});
export type FilterStatus = z.infer<typeof FilterStatus>;

/**
 * A group of keywords and statuses that a user filters, with where it applies and what is done with
 * what it matches.
 * @see https://docs.joinmastodon.org/entities/Filter/
 */
export const Filter = z.object({
    id: z.string(),
    title: z.string(),
    /** Where it applies. `home` covers lists too. */
    context: z.array(z.enum(["home", "notifications", "public", "thread", "account"])),
    /** When it stops applying, or `null` if it never does. */
    expires_at: z.iso.datetime().nullable(),
    /** Whether what it matches is shown behind a warning or left out. */
    filter_action: z.enum(["warn", "hide"]),
    /** Left out where a status says which filters it matches. */
    keywords: z.array(FilterKeyword).optional(),
    /** Left out where a status says which filters it matches. */
    statuses: z.array(FilterStatus).optional(),
});
export type Filter = z.infer<typeof Filter>;
