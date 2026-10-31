import { z } from "zod";

/**
 * A list of accounts that a user made, to read their statuses apart from home.
 * @see https://docs.joinmastodon.org/entities/List/
 */
export const List = z.object({
    id: z.string(),
    title: z.string(),
    /**
     * Which replies the list shows: to anyone the user follows, to the list's members, or none.
     */
    replies_policy: z.enum(["followed", "list", "none"]),
    /** Whether the members' statuses are left out of the user's home timeline. */
    exclusive: z.boolean(),
});
export type List = z.infer<typeof List>;
