import type { Generated } from "kysely";

/**
 * One account following another, or requesting to. A follow of a locked account, or of one on a
 * remote instance, is a request until it is accepted.
 */
export type FollowsTable = {
    /** Orders follows by creation time, for paging through them. */
    id: string;
    follower_id: string;
    followee_id: string;
    /** Whether the followee accepted, or `false` while it is a request. */
    accepted: boolean;
    /** Whether the followee's boosts appear in the follower's home timeline. */
    show_reblogs: Generated<boolean>;
    /** Whether the follower is notified when the followee posts. */
    notify: Generated<boolean>;
    /** The ISO 639-1 codes of the languages the follower sees, or `null` for all. */
    languages: string[] | null;
    created_at: Date;
};

/** An account blocking another, which only the blocker, and moderators, know about. */
export type BlocksTable = {
    /** Orders blocks by creation time, for paging through them. */
    id: string;
    /** Who blocks. */
    account_id: string;
    /** Who is blocked. */
    target_id: string;
    created_at: Date;
};

/** An account muting another, as on Mastodon, which only the muter knows about. */
export type MutesTable = {
    /** Orders mutes by creation time, for paging through them. */
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

/**
 * An account that a local user features on their profile, which Mastodon calls endorsing it. Only
 * accounts the user follows are featured.
 */
export type EndorsementsTable = {
    /** Orders endorsements by creation time, for paging through them. */
    id: string;
    /** Who features the account. */
    account_id: string;
    /** Who is featured. */
    target_id: string;
    created_at: Date;
};

/** What an account privately notes about another, which only it sees, as on Mastodon. */
export type AccountNotesTable = {
    /** Who wrote it. */
    account_id: string;
    /** Who it is about. */
    target_id: string;
    comment: string;
    updated_at: Date;
};

/**
 * A domain an account blocks, which blocks every account there, and on its subdomains, as a block
 * of each would.
 */
export type AccountDomainBlocksTable = {
    /** Orders domain blocks by creation time, for paging through them. */
    id: string;
    /** Who blocks. */
    account_id: string;
    /** The domain blocked, in lowercase. */
    domain: string;
    created_at: Date;
};
