import { z } from "zod";
import { Account } from "./account.ts";
import { Status } from "./status.ts";

/**
 * What a notification is about: Mastodon's types, and Versia Server's `reaction`. Clients ignore
 * types they don't know.
 * @see https://docs.joinmastodon.org/entities/Notification/#type
 */
export const NotificationType = z.enum([
    "mention",
    "status",
    "reblog",
    "follow",
    "follow_request",
    "favourite",
    "poll",
    "update",
    "admin.sign_up",
    "admin.report",
    "severed_relationships",
    "moderation_warning",
    "quote",
    "quoted_update",
    "reaction",
]);
export type NotificationType = z.infer<typeof NotificationType>;

/**
 * Something that happened that concerns the user.
 * @see https://docs.joinmastodon.org/entities/Notification/
 */
export const Notification = z.object({
    id: z.string(),
    type: NotificationType,
    /** Shared by notifications grouped together, or `ungrouped-<id>` for one on its own. */
    group_key: z.string(),
    created_at: z.iso.datetime(),
    /** Who did it. */
    account: Account,
    /** The status it is about, for the types about one. */
    status: Status.optional(),
    /**
     * The emoji of a `reaction`: a Unicode emoji, or a custom one's shortcode in colons, as the
     * status's reactions name it. As Pleroma has it on its emoji reaction notifications.
     */
    emoji: z.string().optional(),
    /** The picture of a `reaction`'s custom emoji, or `null` for a Unicode one. As on Pleroma. */
    emoji_url: z.url().nullable().optional(),
});
export type Notification = z.infer<typeof Notification>;
