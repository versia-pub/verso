import { z } from "zod";

/**
 * A role as Versia's role endpoints render it, with the permissions it grants. Versia Server's
 * extension to the Mastodon API, which `color` extends in turn.
 * @see https://github.com/versia-pub/server/blob/main/packages/client/schemas/versia.ts
 */
export const VersiaRole = z.object({
    id: z.string(),
    name: z.string(),
    /** Permission names, such as `roles` or `owner:account`. */
    permissions: z.array(z.string()),
    /** Accounts may only manage roles with lower priority than their own highest. */
    priority: z.int(),
    description: z.string(),
    /** Whether the role is displayed on the profiles of accounts that have it. */
    visible: z.boolean(),
    /** The URL of an image for the role. Omitted when it has none. */
    icon: z.url().optional(),
    /** A hex colour, such as `#ff3838`, or empty for none. */
    color: z.string(),
});
export type VersiaRole = z.infer<typeof VersiaRole>;
