/** A note an account likes, which Mastodon calls a favourite. */
export type LikesTable = {
    /** Orders likes by when they were made, for paging through them. */
    id: string;
    account_id: string;
    note_id: string;
    created_at: Date;
};
