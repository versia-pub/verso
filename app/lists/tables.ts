/** Which replies a list shows: to anyone the user follows, to the list's members, or none. */
export const repliesPolicies = ["followed", "list", "none"] as const;

export type RepliesPolicy = typeof repliesPolicies[number];

/** A list of accounts that a local user made, to read their statuses apart from home. */
export type ListsTable = {
    /** Orders lists by creation time. */
    id: string;
    /** Whose list it is. */
    account_id: string;
    title: string;
    replies_policy: RepliesPolicy;
    /** Whether the members' statuses are left out of the user's home timeline. */
    exclusive: boolean;
    created_at: Date;
};

/** An account in a list. */
export type ListAccountsTable = {
    /** Orders members by when they were added, for paging through them. */
    id: string;
    list_id: string;
    account_id: string;
    /**
     * The list owner's follow of the account, or request to follow it, which removing also removes
     * the account from the list, as on Mastodon. `null` if the owner is the account.
     */
    follow_id: string | null;
    created_at: Date;
};
