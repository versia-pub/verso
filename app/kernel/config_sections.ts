/**
 * The sections of the config file that stand on their own, which `Config` assembles.
 * @module
 */
import { Permission } from "./permissions.ts";
import { canonicalizeDomain } from "@versia/protocol";
import { z } from "zod";

/**
 * Whether a login's claim contains a value: a string claim equals it, or a list claim holds it,
 * such as `{ claim = "groups", contains = "versia-users" }`.
 */
const ClaimTest = z.strictObject({ claim: z.string().min(1), contains: z.string().min(1) });

export type ClaimTest = z.infer<typeof ClaimTest>;

/**
 * Who may get an account on first login with an issuer: anyone (`open`), nobody (`closed`, so only
 * logins already linked to an account get in), or anyone whose claim contains a value.
 */
const Registration = z.union([z.enum(["open", "closed"]), ClaimTest]);

/**
 * A role the issuer grants to whoever's claim contains a value, by the role's name. Roles live in
 * the database, so a rule may name one that doesn't exist yet; logins skip it until it does.
 */
const RoleRule = ClaimTest.extend({ role: z.string().min(1) });

/** An OpenID Connect provider users log in with. Verso is a client registered with it. */
export const Issuer = z.strictObject({
    /** Shown on the login page when there is more than one issuer. */
    name: z.string().min(1),
    /** The issuer's URL. Accounts are linked to it, so changing it unlinks them all. */
    url: z.url({ protocol: /^https$/, error: "Must be an https URL" }),
    client_id: z.string().min(1),
    /** Keep it out of the config file with a reference, such as `${file:/run/secrets/oidc}`. */
    client_secret: z.string().min(1),
    /** The claim a new account's username comes from. */
    username_claim: z.string().min(1).default("preferred_username"),
    /** Scopes to request besides `openid` and `profile`, such as `groups` for a groups claim. */
    scopes: z.array(z.string().regex(/^\S+$/, { error: "A scope can't contain spaces" }))
        .default([]),
    registration: Registration.default("closed"),
    /** Re-evaluated at every login, which replaces the roles the issuer granted before. */
    roles: z.array(RoleRule).default([]),
});

/** An origin with no path, such as `http://localhost:8080`. */
export const Origin = z.url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).origin === url.replace(/\/$/, ""), {
        error: "Must be an origin, such as http://localhost:8080, with no path",
    })
    .transform((url) => new URL(url).origin);

/**
 * How long and how many of what users write may be, in characters, counted by code point, how many
 * media attachments they may add, and how polls are limited.
 */
export const Limits = z.strictObject({
    display_name: z.int().min(1).default(60),
    /** The bio. */
    note: z.int().min(1).default(10_000),
    /** How many profile fields an account may have. */
    fields: z.int().min(0).default(16),
    field_name: z.int().min(1).default(255),
    field_value: z.int().min(1).default(255),
    /** A status, with its content warning, counted as Mastodon counts them. */
    status: z.int().min(1).default(10_000),
    /** How many media attachments a status may have. */
    attachments: z.int().min(0).default(16),
    /**
     * How many accounts a status may mention, local or remote. Each costs queries, and perhaps a
     * fetch, so the rest are left as text. At most 150, so that a deleted status's mentions fit in
     * the message that streams its deletion.
     */
    mentions: z.int().min(0).max(150).default(100),
    /** A media attachment's description, its alt text. */
    media_description: z.int().min(1).default(4000),
    /** How many options a poll may have. */
    poll_options: z.int().min(2).default(20),
    /** A poll's option. */
    poll_option: z.int().min(1).default(60),
    /** How long a poll may run, at least and at most, in seconds. */
    poll_min_seconds: z.int().min(1).default(300),
    poll_max_seconds: z.int().min(1).default(2_629_746),
})
    .refine((limits) => limits.poll_min_seconds <= limits.poll_max_seconds, {
        error: "poll_min_seconds can't be more than poll_max_seconds",
        path: ["poll_min_seconds"],
    })
    .prefault({});

export type Limits = z.infer<typeof Limits>;

/**
 * A long text about the instance, such as its privacy policy, and the day it last changed. Long
 * texts are best stored in a file and read with `${file:…}`.
 */
const Document = z.strictObject({
    /** Plain text, with a blank line between paragraphs. */
    text: z.string().trim().min(1),
    /** A TOML date, such as `2026-10-01`. */
    updated: z.date({ error: "Must be a date, such as 2026-10-01, without quotes" }),
});

/** Who may see something: nobody, signed-in users, or everyone. */
const Audience = z.enum(["none", "users", "all"]);

/** What the instance tells people about itself. */
export const Instance = z.strictObject({
    /** Its name. Without one, it goes by its domain. */
    name: z.string().trim().min(1).optional(),
    /** A short paragraph about it, in plain text. */
    description: z.string().trim().default(""),
    /** Who to contact about it. */
    contact: z.strictObject({
        email: z.email().optional(),
        /** A local account, by username. */
        account: z.string().min(1).optional(),
    }).prefault({}),
    /** What people agree to follow there, each with an optional hint saying more. */
    rules: z.array(
        z.strictObject({
            text: z.string().trim().min(1),
            hint: z.string().trim().default(""),
            /** The rule in other languages, by language code. */
            translations: z.record(
                z.string().min(1),
                z.strictObject({
                    text: z.string().trim().min(1),
                    hint: z.string().trim().default(""),
                }),
            ).default({}),
        }),
    ).default([]),
    /** A longer text about it, for its about page. */
    extended_description: Document.optional(),
    privacy_policy: Document.optional(),
    /** In force from its `updated` date. */
    terms_of_service: Document.optional(),
    /** Whether `/api/v1/instance/peers` lists the instances Verso knows of. */
    show_peers: z.boolean().default(true),
    /** Whether `/api/v1/instance/activity` gives weekly counts of statuses, logins and sign-ups. */
    show_activity: z.boolean().default(true),
    /** Who `/api/v1/instance/domain_blocks` shows the blocked instances to. */
    show_blocks: Audience.default("none"),
    /** Who sees why each instance was blocked, if they see the blocks. */
    show_block_reasons: Audience.default("none"),
    /**
     * Whether `/api/v1/trends/tags`, `/api/v1/trends/statuses` and `/api/v1/trends/links` list what
     * is trending.
     */
    show_trends: z.boolean().default(true),
    /**
     * Whether hashtags, accounts and links trend before an admin approves them. Either way, an
     * admin can reject what they don't want.
     */
    trendable_by_default: z.boolean().default(false),
    /**
     * Accounts to suggest to every user who doesn't follow them yet, such as `alice` or
     * `bob@b.example`. Remote ones must be known to Verso already.
     */
    suggested_accounts: z.array(z.string().min(1)).default([]),
}).prefault({});

/** What everyone may do, before any role adds more. */
export const Permissions = z.strictObject({
    /** For requests without a user, such as a logged-out visitor's. */
    anonymous: z.array(Permission).default([
        "read:account",
        "read:account_follows",
        "read:note",
        "read:note_likes",
        "read:note_boosts",
        "read:reaction",
        "search",
    ]),
    /** For every user. */
    default: z.array(Permission).default([
        "read:account",
        "read:account_follows",
        "read:note",
        "read:note_likes",
        "read:note_boosts",
        "read:reaction",
        "read:emoji",
        "search",
        "owner:account",
        "owner:block",
        "owner:bookmark",
        "owner:boost",
        "owner:emoji",
        "owner:filter",
        "owner:follow",
        "owner:like",
        "owner:list",
        "owner:media",
        "owner:mute",
        "owner:note",
        "owner:notification",
        "owner:reaction",
        "owner:report",
    ]),
}).prefault({});

export type Permissions = z.infer<typeof Permissions>;

/** A remote instance's domain, in the form signatures name it. */
export const DomainName = z.string().transform((domain, ctx) => {
    const canonical = canonicalizeDomain(domain);
    if (canonical === undefined) ctx.addIssue({ code: "custom", message: "Must be a domain name" });
    return canonical ?? domain;
});

/** A bucket on a server that speaks S3. */
const S3Storage = z.strictObject({
    /** The server's URL, such as `https://s3.eu-west-1.amazonaws.com`. */
    endpoint: z.url({ protocol: /^https?$/ }),
    /** Such as `us-east-1`, or whatever the server is set up with, such as `garage`. */
    region: z.string().min(1),
    /** In S3's form, such as `verso-media`: lowercase letters, digits, dots and hyphens. */
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
        error: "Must be a bucket name, such as verso-media",
    }),
    /** What objects' names start with, such as `verso/media`, to share the bucket with others. */
    prefix: z.string()
        .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/, {
            error: "Must be a path such as verso/media, of letters, digits, dots, - and _",
        })
        .transform((prefix) => prefix.replace(/\/$/, ""))
        .optional(),
    access_key_id: z.string().min(1),
    /** Keep it out of the config file with a reference, such as `${file:/run/secrets/s3}`. */
    secret_access_key: z.string().min(1),
    /**
     * Where the bucket's files are public, such as a CDN in front of it, each at
     * `<public_url>/<key>`. Without it, Verso serves them.
     */
    public_url: z.url({ protocol: /^https?$/ }).optional(),
    /** How long a request to the server may take, uploads included, before it is given up on. */
    timeout_seconds: z.int().min(1).default(120),
});

/**
 * Exactly one of a directory, by its path, or a bucket on a server that speaks S3. Both are
 * optional until then, rather than a union, so a mistake in either is reported where it is.
 */
export const FileStorage = z.strictObject({
    filesystem: z.string().min(1).optional(),
    s3: S3Storage.optional(),
}).transform((storage, ctx): { filesystem: string } | { s3: z.infer<typeof S3Storage> } => {
    if (storage.filesystem !== undefined && storage.s3 === undefined) {
        return { filesystem: storage.filesystem };
    }
    if (storage.s3 !== undefined && storage.filesystem === undefined) return { s3: storage.s3 };

    ctx.addIssue({ code: "custom", message: 'Set exactly one of "filesystem" or "s3"' });
    return z.NEVER;
});

/** How large uploads may be. */
export const MediaLimits = z.strictObject({
    /**
     * How many pixels an uploaded image may have, in each frame, before it is scaled down.
     */
    max_pixels: z.int().min(1).default(8_294_400),
    /** How many bytes an uploaded file may have. */
    max_upload_bytes: z.int().min(1).default(16 * 1024 * 1024),
    /** How many bytes a custom emoji's uploaded picture may have. */
    max_emoji_bytes: z.int().min(1).default(256 * 1024),
});

export type MediaLimits = z.infer<typeof MediaLimits>;

/**
 * How much one user may stream, since every socket, and every stream it subscribes to, costs work
 * for each event.
 */
export const StreamingLimits = z.strictObject({
    /** How many WebSockets each account may have open at once, on each process. */
    sockets_per_account: z.int().min(1).default(10),
    /** How many streams each WebSocket may subscribe to. */
    subscriptions: z.int().min(1).default(100),
    /** How long a hashtag a stream is for may be, in characters. */
    tag_length: z.int().min(1).default(100),
}).prefault({});

export type StreamingLimits = z.infer<typeof StreamingLimits>;

/** Who may see a kind of feed: anyone, only logged-in users, or only those allowed to. */
export const FeedAccess = z.enum(["public", "authenticated", "disabled"]);

export type FeedAccess = z.infer<typeof FeedAccess>;

/**
 * Who may see the statuses of other users that are on the instance (`local`) or from other
 * instances (`remote`), as Mastodon 4.5 lets admins choose.
 */
const feeds = (topic: boolean) =>
    z.strictObject({
        /** Statuses from this instance's users. */
        local: (topic ? FeedAccess.exclude(["disabled"]) : FeedAccess).default("public"),
        /** Statuses from other instances' users. */
        remote: FeedAccess.default("public"),
    }).prefault({});

/**
 * Who may see the public timelines, which logged-out visitors can by default. Accounts whose
 * roles have the `feeds` permission see them even where they are `disabled`.
 */
export const TimelinesAccess = z.strictObject({
    /** The public timeline and its streams. */
    live_feeds: feeds(false),
    /**
     * The hashtag and trending link timelines and the hashtag streams. As on Mastodon, local ones
     * can't be disabled.
     */
    topic_feeds: feeds(true),
}).prefault({});

export type TimelinesAccess = z.infer<typeof TimelinesAccess>;

/**
 * How much one search may ask for, so that it can't make Verso do unbounded work. Mastodon has no
 * such limits.
 */
export const SearchLimits = z.strictObject({
    /** How long a query may be, in characters. */
    query_length: z.int().min(1).default(500),
    /** How many results a search may skip. */
    max_offset: z.int().min(0).default(10_000),
}).prefault({});

export type SearchLimits = z.infer<typeof SearchLimits>;

/** How Web Push is sent. */
export const PushSettings = z.strictObject({
    /**
     * How long a push service has to respond, so a slow one can't hold a worker. One that takes
     * longer isn't tried again, as it would hold a worker as long each time.
     */
    timeout_seconds: z.int().min(1).default(10),
}).prefault({});
