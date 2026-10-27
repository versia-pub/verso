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
 * identities an admin linked), or anyone whose claim contains a value.
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
 * How long and how many of what users write may be, in characters, counted by code point, and how
 * many media attachments they may add.
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
     * fetch, so the rest are left as text.
     */
    mentions: z.int().min(0).default(100),
    /** A media attachment's description, its alt text. Mastodon's limit by default. */
    media_description: z.int().min(1).default(4000),
}).prefault({});

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
        }),
    ).default([]),
    /** A longer text about it, for its about page. */
    extended_description: Document.optional(),
    privacy_policy: Document.optional(),
    /** In force from its `updated` date. */
    terms_of_service: Document.optional(),
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
        "owner:account",
        "owner:block",
        "owner:boost",
        "owner:emoji",
        "owner:follow",
        "owner:like",
        "owner:media",
        "owner:mute",
        "owner:note",
        "owner:reaction",
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
     * Mastodon's limit, 3840×2160, by default.
     */
    max_pixels: z.int().min(1).default(8_294_400),
    /**
     * How many bytes an uploaded file may have. Mastodon's limit for images, 16 MiB, by default.
     */
    max_upload_bytes: z.int().min(1).default(16 * 1024 * 1024),
    /** How many bytes a custom emoji's uploaded picture may have. 256 KiB by default. */
    max_emoji_bytes: z.int().min(1).default(256 * 1024),
});

export type MediaLimits = z.infer<typeof MediaLimits>;
