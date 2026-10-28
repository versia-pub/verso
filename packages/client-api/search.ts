import { z } from "zod";
import { Account } from "./account.ts";
import { Status } from "./status.ts";
import { Tag } from "./tag.ts";

/**
 * What a search found.
 * @see https://docs.joinmastodon.org/entities/Search/
 */
export const Search = z.object({
    accounts: z.array(Account),
    statuses: z.array(Status),
    hashtags: z.array(Tag),
});
export type Search = z.infer<typeof Search>;
