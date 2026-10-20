import { z } from "zod";
import { CustomEmoji } from "./custom_emoji.ts";
import { AccountRole, Role } from "./role.ts";

/**
 * A name and value pair on a profile, such as a website.
 * @see https://docs.joinmastodon.org/entities/Account/#Field
 */
export const Field = z.object({
    name: z.string(),
    /** HTML. */
    value: z.string(),
    /** When a `rel="me"` link back from the value's page was found, or `null` if not. */
    verified_at: z.iso.datetime().nullable(),
});
export type Field = z.infer<typeof Field>;

/** Who sees a status: everyone, everyone but not in public timelines, followers, or mentions. */
export const Visibility = z.enum(["public", "unlisted", "private", "direct"]);
export type Visibility = z.infer<typeof Visibility>;

/** Who is approved for something in general, such as to feature an account or quote a status. */
export const ApprovedAudiences = z.array(
    z.enum(["public", "followers", "following", "unsupported_policy"]),
);

/**
 * Who may feature an account in a collection, and whether the viewer may.
 * @see https://docs.joinmastodon.org/entities/FeatureApproval/
 */
export const FeatureApproval = z.object({
    /** Who is accepted without the account's owner reviewing it. */
    automatic: ApprovedAudiences,
    /** Who is accepted once the account's owner reviews it. */
    manual: ApprovedAudiences,
    /** `unknown` and `missing` mean the same as `denied`. */
    current_user: z.enum(["automatic", "manual", "denied", "unknown", "missing"]),
});
export type FeatureApproval = z.infer<typeof FeatureApproval>;

/**
 * A user, on this instance or another, as anyone sees them.
 * @see https://docs.joinmastodon.org/entities/Account/
 */
export const Account = z.object({
    id: z.string(),
    /** Without the domain. */
    username: z.string(),
    /** `username` for local accounts, and `username@domain` for remote ones. */
    acct: z.string(),
    /** The profile's web page, or `null` if it has none. */
    url: z.url().nullable(),
    /** The account's id in the federation protocol. */
    uri: z.url(),
    display_name: z.string(),
    /** The bio, as HTML. */
    note: z.string(),
    avatar: z.url(),
    /** The avatar, not animated. */
    avatar_static: z.url(),
    avatar_description: z.string(),
    header: z.url(),
    header_static: z.url(),
    header_description: z.string(),
    /** Whether follow requests wait for approval. */
    locked: z.boolean(),
    fields: z.array(Field),
    /** The emojis used in the display name, bio and fields. */
    emojis: z.array(CustomEmoji),
    bot: z.boolean(),
    group: z.boolean(),
    /** Whether it may be suggested to others and listed in the directory. */
    discoverable: z.boolean().nullable(),
    /** Whether its public statuses may appear in search results. */
    indexable: z.boolean(),
    /** Whether search engines should leave its pages out. Only local accounts have it. */
    noindex: z.boolean().nullable().optional(),
    /** The account its user moved to, if they did. */
    get moved(): z.ZodOptional<z.ZodNullable<typeof Account>> {
        return Account.nullable().optional();
    },
    /** Present, and `true`, only for memorial accounts. */
    memorial: z.literal(true).optional(),
    /** Present, and `true`, only for suspended accounts. */
    suspended: z.literal(true).optional(),
    /** Present, and `true`, only for accounts hidden behind a warning. */
    limited: z.literal(true).optional(),
    /** At midnight UTC on the day, rather than the exact time. */
    created_at: z.iso.datetime(),
    /** The day of its newest status, such as `2026-01-31`, or `null` if it has none. */
    last_status_at: z.iso.date().nullable(),
    statuses_count: z.int().min(0),
    followers_count: z.int().min(0),
    following_count: z.int().min(0),
    /** Whether its followers and follows are hidden from others. */
    hide_collections: z.boolean().nullable(),
    /** Whether its profile has a tab of media. */
    show_media: z.boolean(),
    /** Whether that tab includes replies. */
    show_media_replies: z.boolean(),
    /** Whether its profile has a tab of featured accounts and hashtags. */
    show_featured: z.boolean(),
    /** The roles shown on its profile, or `null` for remote accounts. */
    roles: z.array(AccountRole).nullable(),
    feature_approval: FeatureApproval,
    /** Present, and `true`, when its `acct` can't be checked, so may not work elsewhere. */
    invalid_handle: z.literal(true).optional(),
});
export type Account = z.infer<typeof Account>;

/**
 * An account's settings as its owner wrote them, which they read and change through the API.
 * @see https://docs.joinmastodon.org/entities/Account/#source
 */
export const AccountSource = z.object({
    /** The bio, as plain text. */
    note: z.string(),
    fields: z.array(Field),
    /** The default visibility of new statuses. */
    privacy: Visibility,
    /** Whether new statuses are marked sensitive by default. */
    sensitive: z.boolean(),
    /** The default language of new statuses, as an ISO 639-1 code, or empty for none. */
    language: z.string(),
    /** How many follow requests are waiting. */
    follow_requests_count: z.int().min(0),
    hide_collections: z.boolean().nullable(),
    discoverable: z.boolean().nullable(),
    indexable: z.boolean(),
    /** The websites that may credit the account as an author. */
    attribution_domains: z.array(z.string()),
    /** Who may quote new statuses by default. */
    quote_policy: z.enum(["public", "followers", "nobody"]),
});
export type AccountSource = z.infer<typeof AccountSource>;

/**
 * The viewer's own account, with its settings.
 * @see https://docs.joinmastodon.org/entities/Account/#CredentialAccount
 */
export const CredentialAccount = Account.extend({
    source: AccountSource,
    role: Role,
});
export type CredentialAccount = z.infer<typeof CredentialAccount>;
