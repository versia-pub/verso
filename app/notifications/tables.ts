import type { Generated } from "kysely";

/**
 * What a notification is about, by Mastodon's names, and Versia Server's for reactions.
 * @see https://docs.joinmastodon.org/entities/Notification/#type
 */
export type NotificationType =
    /** Someone mentioned the user in a status. */
    | "mention"
    /** Someone the user follows, with notifications on, posted a status. */
    | "status"
    /** Someone boosted one of the user's statuses. */
    | "reblog"
    /** Someone followed the user. */
    | "follow"
    /** Someone requested to follow the user. */
    | "follow_request"
    /** Someone liked one of the user's statuses. */
    | "favourite"
    /** Someone reacted to one of the user's statuses. */
    | "reaction"
    /** A status the user boosted was edited. */
    | "update";

/**
 * A local user's notification. The columns it doesn't need are `null`; the ones it has are deleted
 * with it.
 */
export type NotificationsTable = {
    /** Orders notifications by creation time, for paging through them. */
    id: string;
    /** Who is notified, a local user. */
    account_id: string;
    type: NotificationType;
    /** Who did it. */
    from_account_id: string;
    /** The status it is about, for every type but follows and follow requests. */
    note_id: string | null;
    /** The boost, for a `reblog`. */
    share_id: string | null;
    /** The like, for a `favourite`. */
    like_id: string | null;
    /** The reaction, for a `reaction`. */
    reaction_id: string | null;
    /** The follow or follow request, for a `follow` or `follow_request`. */
    follow_id: string | null;
    /**
     * The group it is in, for the types that are grouped: `<type>-<status id>-<hour>`, with no
     * status id for follows, as on Mastodon. `null` for the others.
     */
    group_key: string | null;
    /**
     * Whether the user's policy filtered it, so it is only listed when asked for, and wasn't
     * streamed or pushed.
     */
    filtered: Generated<boolean>;
    created_at: Date;
};

/** What a policy does with the notifications it applies to, as on Mastodon. */
export const policyActions = ["accept", "filter", "drop"] as const;
export type PolicyAction = (typeof policyActions)[number];

/**
 * A local user's notification policy, as Mastodon's: what is done with notifications from
 * accounts of each kind. Users without one have the defaults.
 * @see https://docs.joinmastodon.org/entities/NotificationPolicy/
 */
export type NotificationPoliciesTable = {
    account_id: string;
    /** From accounts the user doesn't follow. */
    for_not_following: PolicyAction;
    /** From accounts that don't follow the user, or only started to in the last 3 days. */
    for_not_followers: PolicyAction;
    /** From accounts made in the last 30 days, that the user doesn't follow. */
    for_new_accounts: PolicyAction;
    /** Of direct statuses that aren't replies to the user's own, from accounts they don't follow. */
    for_private_mentions: PolicyAction;
    /** From accounts a moderator limited, which Verso has none of yet. */
    for_limited_accounts: PolicyAction;
    updated_at: Date;
};

/**
 * The filtered mentions of a local user from one account, which they may accept or dismiss, as
 * Mastodon's notification requests.
 * @see https://docs.joinmastodon.org/entities/NotificationRequest/
 */
export type NotificationRequestsTable = {
    /** Orders requests by creation time, for paging through them. */
    id: string;
    account_id: string;
    from_account_id: string;
    /** The latest status that filtered mention is about, or `null` once it is deleted. */
    last_note_id: string | null;
    /** How many filtered mentions there are, counting up to 100. */
    notifications_count: number;
    created_at: Date;
    updated_at: Date;
};

/** Every type of notification, which the type's own checks keep complete. */
const typeNames = {
    mention: true,
    status: true,
    reblog: true,
    follow: true,
    follow_request: true,
    favourite: true,
    reaction: true,
    update: true,
} as const satisfies Record<NotificationType, true>;

const types: ReadonlySet<string> = new Set(Object.keys(typeNames));

/** Whether `type` is a type of notification Verso has. */
export const isNotificationType = (type: string): type is NotificationType => types.has(type);
