/** A hashtag that a status, local or remote, has used. */
export type TagsTable = {
    /** In lower case, without the `#`, as statuses' hashtags are matched. */
    name: string;
    /** As it was first written, without the `#`. */
    display_name: string;
};
