/** A hashtag that a status, local or remote, has used. */
export type TagsTable = {
    /** In lower case, without the `#`, as statuses' hashtags are matched. */
    name: string;
    /** As it was first written, without the `#`. */
    display_name: string;
};

/** A hashtag that a local user features on their profile, as Mastodon has them. */
export type FeaturedTagsTable = {
    /** Orders featured hashtags by creation time. */
    id: string;
    account_id: string;
    /** The hashtag, in `tags`. */
    tag: string;
    /** The hashtag as the user wrote it, without its `#`. */
    name: string;
    created_at: Date;
};
