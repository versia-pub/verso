import { z } from "zod";

/**
 * A fetch the server is running in the background, such as of the replies of a thread, which a
 * response named in its `Mastodon-Async-Refresh` header.
 * @see https://docs.joinmastodon.org/entities/AsyncRefresh/
 */
export const AsyncRefresh = z.object({
    id: z.string(),
    status: z.enum(["running", "finished"]),
    /** How many new results it found so far, if it counts them. */
    result_count: z.int().nullable(),
});
export type AsyncRefresh = z.infer<typeof AsyncRefresh>;
