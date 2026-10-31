import { z } from "zod";
import { Account } from "./account.ts";
import { Status } from "./status.ts";

/**
 * The notifications from one account that the viewer's policy filtered, which they may accept or
 * dismiss.
 * @see https://docs.joinmastodon.org/entities/NotificationRequest/
 */
export const NotificationRequest = z.object({
    id: z.string(),
    /** When the first of them was filtered. */
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    account: Account,
    /** How many of them were filtered, as a string. */
    notifications_count: z.string(),
    /** The latest status they are about. */
    last_status: Status.nullish(),
});
export type NotificationRequest = z.infer<typeof NotificationRequest>;
