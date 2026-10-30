import type { Generated } from "kysely";
import type { TextFormat } from "../accounts/tables.ts";
import type { Visibility } from "../kernel/visibility.ts";

/** A status, local or remote. */
export type NotesTable = {
    /** Orders statuses by creation time, for paging through them. */
    id: string;
    /** The author. */
    account_id: string;
    /** The instance it came from, or `null` if it is a local status. */
    instance_id: string | null;
    /** Its id on that instance. */
    remote_id: string | null;
    visibility: Visibility;
    /** As its author wrote it. */
    content: string;
    content_format: TextFormat;
    /**
     * As HTML: Verso's rendering for local statuses, and the remote instance's own for remote
     * statuses, sanitised when displayed.
     */
    content_html: string;
    /** A warning shown in place of the content until it is opened, or empty for none. */
    spoiler_text: Generated<string>;
    sensitive: Generated<boolean>;
    /** An ISO 639-1 code, or `null` if unknown. */
    language: string | null;
    /** The status it replies to, or `null` if none, or if it has been deleted. */
    in_reply_to_id: string | null;
    in_reply_to_account_id: string | null;
    /**
     * The status it quotes, or `null` if none, or if it has been deleted. Only remote statuses
     * quote so far.
     */
    quote_id: string | null;
    /**
     * The status it boosts (Mastodon calls this a reblog), or `null` if it isn't a boost. A boost
     * has no content of its own, and is deleted with the status it boosts.
     */
    reblog_of_id: string | null;
    replies_count: Generated<number>;
    likes_count: Generated<number>;
    shares_count: Generated<number>;
    created_at: Date;
    edited_at: Date | null;
    /** When it was last fetched or sent, or `null` if it is a local status. */
    fetched_at: Date | null;
};

/** An account mentioned by a status, which may see it whatever its visibility. */
export type NoteMentionsTable = {
    note_id: string;
    account_id: string;
};

/** A hashtag used by a status, in lower case. */
export type NoteTagsTable = {
    note_id: string;
    name: string;
};

/** A media attachment a status had before an edit. */
export type VersionMedia = { readonly id: string; readonly description: string | null };

/** What a status said before an edit, as its edit history shows it. */
export type NoteVersionsTable = {
    /** Orders a status's versions, oldest first. */
    id: string;
    note_id: string;
    content_html: string;
    spoiler_text: string;
    sensitive: boolean;
    /** The media it had attached, in order, with their descriptions at the time. */
    media: Generated<VersionMedia[]>;
    /** When the status came to say this: when it was created, or the previous edit. */
    created_at: Date;
};

/** A status that its author features on their profile, which Mastodon calls pinning it. */
export type NotePinsTable = {
    /** Orders pins by creation time. */
    id: string;
    /** The account that pins it, always its author. */
    account_id: string;
    note_id: string;
    created_at: Date;
};

/** A status that a local account bookmarked, which only that account sees. */
export type BookmarksTable = {
    /** Orders bookmarks by creation time. */
    id: string;
    account_id: string;
    note_id: string;
    created_at: Date;
};

/**
 * How many likes, boosts and replies a remote status has, as its instance reports, each `null` if
 * the instance doesn't report it. Verso shows the larger of these and what it counted itself.
 */
export type RemoteNoteTotalsTable = {
    note_id: string;
    likes: number | null;
    shares: number | null;
    replies: number | null;
    fetched_at: Date;
};
