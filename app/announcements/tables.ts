/** An announcement that the instance's admins make to its users. */
export type AnnouncementsTable = {
    id: string;
    /** As the admin wrote it, in plain text. */
    text: string;
    /** `text` as HTML, with its mentions and hashtags linked as they were when it was saved. */
    content_html: string;
    /** The accounts it mentions, as found when it was saved. */
    account_ids: string[];
    /** The public and unlisted statuses it links to, as found when it was saved. */
    note_ids: string[];
    /** When the event it announces starts and ends, if it is about one. */
    starts_at: Date | null;
    ends_at: Date | null;
    /** Whether the event lasts whole days. */
    all_day: boolean;
    /** When to publish it, or `null` if it is published, or waits for an admin to publish it. */
    scheduled_at: Date | null;
    /** When it was last published, or `null` while it isn't. */
    published_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

/** The announcements that users dismissed. */
export type AnnouncementDismissalsTable = {
    account_id: string;
    announcement_id: string;
};

/**
 * A user's reaction to an announcement, with an emoji: a Unicode one, as `text`, or a custom one,
 * as `emoji_id`, but never both.
 */
export type AnnouncementReactionsTable = {
    /** Orders reactions by creation time. */
    id: string;
    account_id: string;
    announcement_id: string;
    text: string | null;
    emoji_id: string | null;
    created_at: Date;
};
