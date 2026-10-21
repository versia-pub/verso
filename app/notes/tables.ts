import type { Generated } from "kysely";
import type { TextFormat, Visibility } from "../accounts/tables.ts";

/** A post, local or from another instance. */
export type NotesTable = {
    /** Orders notes by when they were made, for paging through them. */
    id: string;
    /** Who wrote it. */
    account_id: string;
    /** The instance it came from, or `null` if it was written here. */
    instance_id: string | null;
    /** Its id on that instance. */
    remote_id: string | null;
    visibility: Visibility;
    /** As its author wrote it. */
    content: string;
    content_format: TextFormat;
    /** As HTML: Verso's for local notes, and the instance's own, sanitised when shown, for others. */
    content_html: string;
    /** A warning shown in place of the content until it is opened, or empty for none. */
    spoiler_text: Generated<string>;
    sensitive: Generated<boolean>;
    /** An ISO 639-1 code, or `null` if it isn't known. */
    language: string | null;
    /** The note it replies to, or `null` if none, or it is gone. */
    in_reply_to_id: string | null;
    in_reply_to_account_id: string | null;
    replies_count: Generated<number>;
    created_at: Date;
    edited_at: Date | null;
};

/** An account a note mentions, who may see it whatever its visibility. */
export type NoteMentionsTable = {
    note_id: string;
    account_id: string;
};

/** A hashtag a note uses, in lower case. */
export type NoteTagsTable = {
    note_id: string;
    name: string;
};
