import type { Generated } from "kysely";
import type { Permission } from "../kernel/permissions.ts";
import type { Visibility } from "../kernel/visibility.ts";

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

/**
 * A local or remote user. Rich text, such as the bio, is stored as HTML, which every account has,
 * and, for local accounts, as its owner wrote it, for them to edit. Local HTML is generated when
 * the text is written. Remote HTML is stored as received, and sanitised when displayed.
 */
export type AccountsTable = {
    id: string;
    /** Unique per instance, ignoring case. */
    username: string;
    /** The instance the account lives on, in `instances`, or `null` for the local instance. */
    instance_id: string | null;
    /** The account's id on its own instance, opaque to Verso, or `null` for local accounts. */
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
    /** Whether its followers and following are hidden from others. */
    hide_collections: Generated<boolean>;

    /** Defaults for new statuses, which clients read and change through Mastodon's `source`. */
    default_visibility: Generated<Visibility>;
    default_sensitive: Generated<boolean>;
    /** An ISO 639-1 code, or empty for none. */
    default_language: Generated<string>;

    /** Updated whenever they change, rather than counted when displayed. */
    statuses_count: Generated<number>;
    followers_count: Generated<number>;
    following_count: Generated<number>;
    last_status_at: Date | null;

    /** Its pictures, in `media`. */
    avatar_id: string | null;
    header_id: string | null;
    /** When a remote account was last fetched or received, or `null` for local accounts. */
    fetched_at: Date | null;
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

/** A named set of permissions, which accounts are granted by an admin or by an IdP claim. */
export type RolesTable = {
    id: string;
    /** Unique, ignoring case. */
    name: string;
    description: Generated<string>;
    permissions: Permission[];
    /** Accounts may only manage roles below their own highest. */
    priority: Generated<number>;
    /** Whether the role is displayed on its accounts' profiles. */
    visible: Generated<boolean>;
    /** A hex color such as `#ff0000`, or empty for none. */
    color: Generated<string>;
    /** The URL of an image for the role. */
    icon: string | null;
    created_at: Date;
};

/**
 * A role granted to an account, by an admin or by an issuer mapping its claims. An account may have
 * the same role from several sources, so a login through one issuer only changes what it granted.
 */
export type AccountRolesTable = {
    account_id: string;
    role_id: string;
    /** The issuer whose claims granted the role, or `null` if an admin did. */
    issuer: string | null;
    created_at: Date;
};
