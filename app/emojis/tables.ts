/** A custom emoji, which text shows where it has `:shortcode:`. */
export type EmojisTable = {
    id: string;
    /** The instance it is from, in `instances`, or `null` for this one. */
    instance_id: string | null;
    /** Its name, without the colons around it. */
    shortcode: string;
    /** Its picture, in `media`. */
    media_id: string;
    created_at: Date;
};

/** The emojis a note's content and warning use. */
export type NoteEmojisTable = {
    note_id: string;
    emoji_id: string;
};

/** The emojis an account's display name, bio and fields use. */
export type AccountEmojisTable = {
    account_id: string;
    emoji_id: string;
};
