import type { Generated } from "kysely";

/** Whether an account likes a status or dislikes it. Mastodon has only likes, as favourites. */
export type LikeKind = "like" | "dislike";

/** A status an account likes or dislikes, but never both. */
export type LikesTable = {
    /** Orders likes by creation time, for paging through them. */
    id: string;
    account_id: string;
    note_id: string;
    kind: Generated<LikeKind>;
    /** The instance it came from, or `null` if it was created locally. */
    instance_id: string | null;
    /** Its id on that instance. */
    remote_id: string | null;
    created_at: Date;
};

/**
 * An account's reaction to a status, with an emoji: a Unicode one, as `text`, or a custom one, as
 * `emoji_id`, but never both.
 */
export type ReactionsTable = {
    /** Orders reactions by creation time. */
    id: string;
    account_id: string;
    note_id: string;
    text: string | null;
    emoji_id: string | null;
    /** The instance it came from, or `null` if it was created locally. */
    instance_id: string | null;
    /** Its id on that instance. */
    remote_id: string | null;
    created_at: Date;
};
