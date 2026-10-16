import type { Generated } from "kysely";

/** What a user wrote text in, which decides how it becomes HTML. */
export type TextFormat = "text/plain" | "text/markdown";

/**
 * A profile field, such as a website, as its owner wrote it and as HTML. Only local accounts have
 * the written form; remote ones may have their plain text there.
 */
export type ProfileField = {
    readonly name: string;
    readonly value: string;
    /** What `name` and `value` are written in. */
    readonly format: TextFormat;
    readonly name_html: string;
    readonly value_html: string;
};

/** Who sees a status: everyone, everyone but not in public timelines, followers, or mentions. */
export type Visibility = "public" | "unlisted" | "private" | "direct";

/**
 * A user on this instance or another. Rich text, such as the bio, is kept as HTML, which every
 * account has, and, for local accounts, as its owner wrote it, for them to edit. Local HTML is
 * made when the text is written. Remote HTML is kept as received, and sanitised when shown.
 */
export type AccountsTable = {
    id: string;
    /** Unique per instance, ignoring case. */
    username: string;
    /** The instance the account lives on, in `instances`, or `null` for this one. */
    instance_id: string | null;
    /** The account's id on its own instance, opaque to us, or `null` for local accounts. */
    remote_id: string | null;
    created_at: Date;

    display_name: Generated<string>;
    /** The bio, as its owner wrote it. */
    note: Generated<string>;
    /** What `note` is written in. */
    note_format: Generated<TextFormat>;
    /** The bio, as HTML. */
    note_html: Generated<string>;
    fields: Generated<ProfileField[]>;
    /** Whether follow requests wait for approval. */
    locked: Generated<boolean>;
    bot: Generated<boolean>;
    /** Whether the account may be suggested to others and listed in the directory. */
    discoverable: Generated<boolean>;
    /** Whether its public statuses may appear in search results. */
    indexable: Generated<boolean>;
    /** Whether its followers and follows are hidden from others. */
    hide_collections: Generated<boolean>;

    /** Defaults for new statuses, which clients read and change through Mastodon's `source`. */
    default_visibility: Generated<Visibility>;
    default_sensitive: Generated<boolean>;
    /** An ISO 639-1 code, or empty for none. */
    default_language: Generated<string>;

    /** Kept up to date as they change, rather than counted when shown. */
    statuses_count: Generated<number>;
    followers_count: Generated<number>;
    following_count: Generated<number>;
    last_status_at: Date | null;
};

/** A login at an OpenID issuer, linked to a local account. */
export type IdentitiesTable = {
    /** The issuer URL, as configured. */
    issuer: string;
    /** The ID token's `sub` claim, which the issuer never reuses. */
    subject: string;
    account_id: string;
    created_at: Date;
};
