import { z } from "zod";
import { Account } from "./account.ts";
import { Status } from "./status.ts";

/**
 * A direct conversation: the direct statuses of a thread between the viewer and the same accounts.
 * @see https://docs.joinmastodon.org/entities/Conversation/
 */
export const Conversation = z.object({
    id: z.string(),
    /** Whether someone else posted in it since the viewer last read it. */
    unread: z.boolean(),
    /** The other accounts in it, or the viewer, if there are none. */
    accounts: z.array(Account),
    /** Its latest status. */
    last_status: Status.nullable(),
});
export type Conversation = z.infer<typeof Conversation>;
