import { z } from "zod";

/**
 * A role as others see it, as a badge on the profiles of accounts that have it.
 * @see https://docs.joinmastodon.org/entities/Account/#AccountRole
 */
export const AccountRole = z.object({
    id: z.string(),
    name: z.string(),
    /** A hex colour, such as `#ff3838`, or empty for none. */
    color: z.string(),
});
export type AccountRole = z.infer<typeof AccountRole>;

/**
 * A role in full, as its holder sees it.
 * @see https://docs.joinmastodon.org/entities/Role/
 */
export const Role = AccountRole.extend({
    /** A bitmask of Mastodon's permission flags, in decimal, so `"0"` for none. */
    permissions: z.string().regex(/^\d+$/),
    /** Whether the role is shown on its holders' profiles. */
    highlighted: z.boolean(),
    /** How many collections its holders may make. */
    collection_limit: z.int().min(0),
});
export type Role = z.infer<typeof Role>;
