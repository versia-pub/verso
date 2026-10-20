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
