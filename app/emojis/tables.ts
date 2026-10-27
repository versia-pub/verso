/** A custom emoji, which text displays where it has `:shortcode:`. */
export type EmojisTable = {
    id: string;
    /** The instance it is from, in `instances`, or `null` for the local instance. */
    instance_id: string | null;
    /**
     * The local user it belongs to, who alone may use it, or `null` for a global emoji and for
     * remote instances' emojis.
     */
    account_id: string | null;
    /** Its name, without the colons around it. */
    shortcode: string;
    /** Its picture, in `media`. */
    media_id: string;
    /** The emoji picker's group for it, or `null` for none. */
    category: string | null;
    created_at: Date;
};

/** The custom emojis used in a status's content and content warning. */
export type NoteEmojisTable = {
    note_id: string;
    emoji_id: string;
};

/** The custom emojis used in an account's display name, bio and fields. */
export type AccountEmojisTable = {
    account_id: string;
    emoji_id: string;
};
