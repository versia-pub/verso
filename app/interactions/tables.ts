import type { Generated } from "kysely";

/** Whether an account likes a note or dislikes it. Mastodon has only likes, as favourites. */
export type LikeKind = "like" | "dislike";

/** A note an account likes or dislikes, but never both. */
export type LikesTable = {
    /** Orders likes by when they were made, for paging through them. */
    id: string;
    account_id: string;
    note_id: string;
    kind: Generated<LikeKind>;
    /** The instance it came from, or `null` if it was made here. */
    instance_id: string | null;
    /** Its id on that instance. */
    remote_id: string | null;
    created_at: Date;
};

/**
 * An account's reaction to a note, with an emoji: a Unicode one, as `text`, or a custom one, as
 * `emoji_id`, but never both.
 */
export type ReactionsTable = {
    /** Orders reactions by when they were made. */
    id: string;
    account_id: string;
    note_id: string;
    text: string | null;
    emoji_id: string | null;
    created_at: Date;
};
