import { z } from "zod";

/**
 * A fetch the server runs in the background, like of the replies of a thread. A response names it
 * in its `Mastodon-Async-Refresh` header.
 * @see https://docs.joinmastodon.org/entities/AsyncRefresh/
 */
export const AsyncRefresh = z.object({
    id: z.string(),
    status: z.enum(["running", "finished"]),
    /** How many new results it found so far, if it counts them. */
    result_count: z.int().nullable(),
});
export type AsyncRefresh = z.infer<typeof AsyncRefresh>;
