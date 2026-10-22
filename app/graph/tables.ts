import type { Generated } from "kysely";

/**
 * One account following another, or asking to. A follow of a locked account, or of one on another
 * instance, is a request until it is accepted.
 */
export type FollowsTable = {
    /** Orders follows by when they were made, for paging through them. */
    id: string;
    follower_id: string;
    followee_id: string;
    /** Whether the followee accepted, or `false` while it is a request. */
    accepted: boolean;
    /** Whether the followee's shares appear in the follower's home timeline. */
    show_reblogs: Generated<boolean>;
    /** Whether the follower is notified when the followee posts. */
    notify: Generated<boolean>;
    /** The ISO 639-1 codes of the languages the follower sees, or `null` for all. */
    languages: string[] | null;
    created_at: Date;
};

/** An account blocking another, which only the blocker, and moderators, know of. */
export type BlocksTable = {
    /** Orders blocks by when they were made, for paging through them. */
    id: string;
    /** Who blocks. */
    account_id: string;
    /** Who is blocked. */
    target_id: string;
    created_at: Date;
};

/** An account muting another, as on Mastodon, which only the muter knows of. */
export type MutesTable = {
    /** Orders mutes by when they were made, for paging through them. */
    id: string;
    /** Who mutes. */
    account_id: string;
    /** Who is muted. */
    target_id: string;
    /** Whether the muted account's notifications are muted too. */
    notifications: boolean;
    /** When the mute ends, or `null` if it doesn't. */
    expires_at: Date | null;
    created_at: Date;
};
