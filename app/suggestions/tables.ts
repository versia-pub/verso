/** An account that a user dismissed from the accounts suggested to them. */
export type SuggestionDismissalsTable = {
    /** Who dismissed it. */
    account_id: string;
    /** Who is no longer suggested. */
    target_id: string;
    created_at: Date;
};
