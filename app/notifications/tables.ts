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
    created_at: Date;
};
