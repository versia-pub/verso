/**
 * Renders accounts as the client API's entities.
 * @module
 */
import type { Account, CredentialAccount, CustomEmoji, Field, Role } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { sanitizeHtml } from "../kernel/html.ts";
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
 * pictures: a remote account's own at `url`, a local account's own once processed, stored under
 * `key` with its still preview under `preview`, or else the default at `fallback`.
 */
const pictureUrls = (
    ctx: Context,
    url: string | null,
    key: string | null,
    preview: string | null,
    fallback: string,
) => {
    if (url !== null) return { url, still: url };
    if (key === null) return { url: fallback, still: fallback };

    const file = fileUrl(ctx, key);
    return { url: file, still: preview === null ? file : fileUrl(ctx, preview) };
};

/** An account as anyone sees it, with its roles, highest first, and the custom emojis it uses. */
export const renderAccount = (
    ctx: Context,
    row: AccountRow,
    roles: readonly RoleRow[],
    emojis: readonly CustomEmoji[],
): Account => {
    const avatar = pictureUrls(
        ctx,
        row.avatar_url,
        row.avatar_sha256,
        row.avatar_preview_sha256,
        ctx.urls.url`/accounts/${row.id}/avatar.png`,
    );
    const header = pictureUrls(
        ctx,
        row.header_url,
        row.header_sha256,
        row.header_preview_sha256,
        ctx.urls.url`/accounts/${row.id}/header.png`,
    );
    const local = row.domain === null;

    // Verso's own HTML is made safe when it is written; remote instances' HTML is stored as they
    // sent it.
    const html = local ? (html: string) => html : sanitizeHtml;

    return {
        id: row.id,
        username: row.username,
        acct: local ? row.username : `${row.username}@${row.domain}`,
        // Verso has no profile pages to link to; a web frontend would.
        url: null,
        uri: userUri(ctx, row),
        display_name: row.display_name,
        note: html(row.note_html),
        avatar: avatar.url,
        avatar_static: avatar.still,
        avatar_description: row.avatar_description ?? "",
        header: header.url,
        header_static: header.still,
        header_description: row.header_description ?? "",
        locked: row.locked,
        fields: renderFields(row.fields, (field) => html(field.value_html)),
        emojis: [...emojis],
        bot: row.bot,
        group: false,
        discoverable: row.discoverable,
        indexable: row.indexable,
        created_at: midnight(row.created_at).toISOString(),
        last_status_at: row.last_status_at?.toISOString().slice(0, 10) ?? null,
        statuses_count: row.statuses_count,
        followers_count: row.followers_count,
        following_count: row.following_count,
        hide_collections: row.hide_collections,
        show_media: true,
        show_media_replies: true,
        show_featured: true,
        // Only the roles shown on profiles. Remote accounts have none stored.
        roles: local
            ? roles.filter((role) => role.visible)
                .map((role) => ({ id: role.id, name: role.name, color: role.color }))
            : null,
        // Verso has no collections, so nobody can feature anyone.
        feature_approval: { automatic: [], manual: [], current_user: "denied" },
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
        attribution_domains: [],
        // Verso doesn't restrict quotes.
        quote_policy: "public",
    },
    role: renderRole(roles, permissions),
});
