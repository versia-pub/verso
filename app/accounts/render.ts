/**
 * Renders accounts as the client API's entities.
 * @module
 */
import type {
    Account,
    CredentialAccount,
    CustomEmoji,
    FeaturedTag,
    Field,
    Preferences,
    Profile,
    Role,
} from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { shownHtml } from "../kernel/html.ts";
import { fileUrl } from "../media/render.ts";
import type { AccountRow } from "./account_queries.ts";
import type { Permission } from "../kernel/permissions.ts";
import { mastodonPermissions } from "./permissions.ts";
import type { RoleRow } from "./role_queries.ts";
import type { ProfileField } from "./tables.ts";

/** The role Mastodon gives users that have none. */
const everyone = { id: "-99", name: "", color: "", highlighted: false };

/**
 * The account's highest role, as Mastodon gives each user one, with everything the account may do,
 * from all its roles and what every user may do.
 */
const renderRole = (roles: readonly RoleRow[], permissions: Iterable<Permission>): Role => {
    const [highest] = roles;
    const role = highest
        ? { id: highest.id, name: highest.name, color: highest.color, highlighted: highest.visible }
        : everyone;

    return { ...role, permissions: mastodonPermissions(permissions), collection_limit: 0 };
};

/** Fields, with each value rendered by `value`. */
const renderFields = (
    fields: readonly ProfileField[],
    value: (field: ProfileField) => string,
): Field[] =>
    fields.map((field) => ({
        // Mastodon's names are plain text, so the HTML is only for federation.
        name: field.name,
        value: value(field),
        verified_at: null,
    }));

/** The account's id in Versia: the URL its User entity is fetched from. */
export const userUri = (ctx: Context, row: AccountRow): string => {
    if (row.domain === null) return ctx.urls.url`/.versia/v0.6/entities/User/${row.id}`;

    if (row.remote_id === null) throw new Error(`Remote account ${row.id} has no remote id`);
    return entityUrl(row.domain, "User", row.remote_id).href;
};

/**
 * Midnight UTC on the day of `date`, which is all Mastodon shows of when an account was created.
 */
const midnight = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * The URLs of an account's picture and of a still version of it, for clients that don't animate
 * pictures: the one Verso stores under `key` once processed or cached, with its still preview under
 * `preview`, else a remote account's own at `url`, or else the default at `fallback`.
 */
const pictureUrls = (
    ctx: Context,
    url: string | null,
    key: string | null,
    preview: string | null,
    fallback: string,
) => {
    if (key !== null) {
        const file = fileUrl(ctx, key);
        return { url: file, still: preview === null ? file : fileUrl(ctx, preview) };
    }
    if (url !== null) return { url, still: url };

    return { url: fallback, still: fallback };
};

/**
 * The profile of a suspended account as it is shown: blank, with the default pictures, as on
 * Mastodon. Anything else is shown as it is.
 */
const suspendedAs = (row: AccountRow): AccountRow =>
    row.suspended_at === null ? row : {
        ...row,
        display_name: "",
        note_html: "",
        avatar_url: null,
        avatar_sha256: null,
        avatar_preview_sha256: null,
        avatar_description: null,
        header_url: null,
        header_sha256: null,
        header_preview_sha256: null,
        header_description: null,
        locked: false,
        fields: [],
        bot: false,
        discoverable: false,
        indexable: false,
    };

/**
 * An account as anyone sees it, with its roles, highest first, and the custom emojis it uses. A
 * suspended account says so, and shows nothing of its profile, as on Mastodon.
 */
export const renderAccount = (
    ctx: Context,
    row: AccountRow,
    roles: readonly RoleRow[],
    emojis: readonly CustomEmoji[],
): Account => {
    const shown = suspendedAs(row);
    const avatar = pictureUrls(
        ctx,
        shown.avatar_url,
        shown.avatar_sha256,
        shown.avatar_preview_sha256,
        ctx.urls.url`/accounts/${row.id}/avatar.png`,
    );
    const header = pictureUrls(
        ctx,
        shown.header_url,
        shown.header_sha256,
        shown.header_preview_sha256,
        ctx.urls.url`/accounts/${row.id}/header.png`,
    );
    const local = row.domain === null;

    // Verso's own HTML is made safe when it is written, and remote instances' when it is stored.
    const html = local
        ? (html: string) => html
        : (html: string) => shownHtml(html, row.html_version);

    const uri = userUri(ctx, row);
    const suspended = row.suspended_at !== null;

    return {
        id: row.id,
        username: row.username,
        acct: local ? row.username : `${row.username}@${row.domain}`,
        // Verso has no profile pages to link to, so this is the same as `uri`.
        url: uri,
        uri,
        display_name: shown.display_name,
        note: html(shown.note_html),
        avatar: avatar.url,
        avatar_static: avatar.still,
        avatar_description: shown.avatar_description ?? "",
        header: header.url,
        header_static: header.still,
        header_description: shown.header_description ?? "",
        locked: shown.locked,
        fields: renderFields(shown.fields, (field) => html(field.value_html)),
        emojis: suspended ? [] : [...emojis],
        bot: shown.bot,
        group: false,
        discoverable: shown.discoverable,
        indexable: shown.indexable,
        created_at: midnight(row.created_at).toISOString(),
        last_status_at: row.last_status_at?.toISOString().slice(0, 10) ?? null,
        statuses_count: row.statuses_count,
        followers_count: row.followers_count,
        following_count: row.following_count,
        hide_collections: row.hide_collections,
        show_media: row.show_media,
        show_media_replies: row.show_media_replies,
        show_featured: row.show_featured,
        // Only the roles shown on profiles. Remote accounts have none stored.
        roles: local
            ? (suspended ? [] : roles).filter((role) => role.visible)
                .map((role) => ({ id: role.id, name: role.name, color: role.color }))
            : null,
        // Verso has no collections, so nobody can feature anyone.
        feature_approval: { automatic: [], manual: [], current_user: "denied" },
        ...(suspended ? { suspended: true } : {}),
        ...(row.silenced_at === null ? {} : { limited: true }),
    };
};

/**
 * An account as its owner sees it, with the settings they can change, its roles (highest first),
 * the custom emojis it uses, everything it may do, and how many accounts have requested to follow
 * it.
 */
export const renderCredentialAccount = (
    ctx: Context,
    row: AccountRow,
    roles: readonly RoleRow[],
    emojis: readonly CustomEmoji[],
    permissions: Iterable<Permission>,
    followRequests: number,
): CredentialAccount => ({
    ...renderAccount(ctx, row, roles, emojis),
    source: {
        note: row.note,
        fields: renderFields(row.fields, (field) => field.value),
        privacy: row.default_visibility,
        sensitive: row.default_sensitive,
        language: row.default_language,
        follow_requests_count: followRequests,
        hide_collections: row.hide_collections,
        discoverable: row.discoverable,
        indexable: row.indexable,
        attribution_domains: row.attribution_domains,
        // Verso doesn't restrict quotes.
        quote_policy: "public",
    },
    role: renderRole(roles, permissions),
});

/**
 * A user's own profile as they wrote it, with the hashtags they feature. Pictures they don't have
 * are `null`, not the default ones.
 */
export const renderProfile = (
    ctx: Context,
    row: AccountRow,
    featuredTags: readonly FeaturedTag[],
): Profile => {
    const account = renderAccount(ctx, row, [], []);
    const own = <T>(id: string | null, shown: T): T | null => id === null ? null : shown;
    const field = (value: (field: ProfileField) => string) => (field: ProfileField) => ({
        name: field.name,
        value: value(field),
        verified_at: null,
    });

    return {
        id: row.id,
        display_name: row.display_name,
        note: row.note,
        fields: row.fields.map(field((field) => field.value)),
        formatted_note: account.note,
        formatted_fields: row.fields.map(field((field) => field.value_html)),
        avatar: own(row.avatar_id, account.avatar),
        avatar_static: own(row.avatar_id, account.avatar_static),
        avatar_description: account.avatar_description,
        header: own(row.header_id, account.header),
        header_static: own(row.header_id, account.header_static),
        header_description: account.header_description,
        locked: row.locked,
        bot: row.bot,
        discoverable: row.discoverable,
        indexable: row.indexable,
        hide_collections: row.hide_collections,
        show_media: row.show_media,
        show_media_replies: row.show_media_replies,
        show_featured: row.show_featured,
        attribution_domains: row.attribution_domains,
        featured_tags: [...featuredTags],
    };
};

/**
 * A user's preferences. Verso keeps only those for posting; the others are Mastodon's defaults, and
 * Verso doesn't restrict quotes.
 */
export const renderPreferences = (row: AccountRow): Preferences => ({
    "posting:default:visibility": row.default_visibility,
    "posting:default:sensitive": row.default_sensitive,
    "posting:default:language": row.default_language === "" ? null : row.default_language,
    "posting:default:quote_policy": "public",
    "posting:default:spoiler_field": false,
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
    "reading:autoplay:gifs": false,
});
