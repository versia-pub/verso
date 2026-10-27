import { z } from "zod";
import { Account, PartialAccountWithAvatar } from "./account.ts";
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

/** A reaction's emoji, as a `reaction` notification has it. */
export const ReactionEmoji = Notification.pick({ emoji: true, emoji_url: true }).required();

/**
 * Notifications grouped together, such as the likes of a status, or one on its own.
 * @see https://docs.joinmastodon.org/entities/GroupedNotificationsResults/#NotificationGroup
 */
export const NotificationGroup = z.object({
    /** Opaque, but `ungrouped-<id>` for a notification on its own. */
    group_key: z.string(),
    notifications_count: z.int(),
    type: NotificationType,
    most_recent_notification_id: z.string(),
    /** The group's oldest notification in the page, when paging through groups. */
    page_min_id: z.string().optional(),
    /** The group's newest notification in the page, when paging through groups. */
    page_max_id: z.string().optional(),
    /** When the group's newest notification in the page was made, when paging through groups. */
    latest_page_notification_at: z.iso.datetime().optional(),
    /** Some of the accounts that most recently caused its notifications, newest first. */
    sample_account_ids: z.array(z.string()),
    /** The status it is about, for the types about one. */
    status_id: z.string().optional(),
    /**
     * The different emojis of a `reaction` group's newest reactions, newest first, as its
     * notifications have them. Verso's own, as a group can have several.
     */
    emojis: z.array(ReactionEmoji).optional(),
});
export type NotificationGroup = z.infer<typeof NotificationGroup>;

/**
 * A page of notification groups, with the accounts and statuses they refer to.
 * @see https://docs.joinmastodon.org/entities/GroupedNotificationsResults/
 */
export const GroupedNotificationsResults = z.object({
    accounts: z.array(Account),
    /** The other accounts, in part, when asked for `partial_avatars`. */
    partial_accounts: z.array(PartialAccountWithAvatar).optional(),
    statuses: z.array(Status),
    notification_groups: z.array(NotificationGroup),
});
export type GroupedNotificationsResults = z.infer<typeof GroupedNotificationsResults>;
