/**
 * Turns accounts into the client API's entities.
 * @module
 */
import type { Account, CredentialAccount, Field, Relationship, Role } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import type { AccountRow } from "./accounts.ts";
import { mastodonPermissions, type Permission } from "./permissions.ts";
import type { RoleRow } from "./roles.ts";
import type { ProfileField } from "./tables.ts";

/** The role Mastodon gives users without one. */
const everyone = { id: "-99", name: "", color: "", highlighted: false };

/**
 * The account's highest role, as Mastodon gives each user one, with everything the account may do,
 * from all its roles and what every user may.
 */
const renderRole = (roles: readonly RoleRow[], permissions: Iterable<Permission>): Role => {
    const [highest] = roles;
    const role = highest
        ? { id: highest.id, name: highest.name, color: highest.color, highlighted: highest.visible }
        : everyone;

    return { ...role, permissions: mastodonPermissions(permissions), collection_limit: 0 };
};

/** Fields as HTML, or as their owner wrote them, for them to edit. */
const renderFields = (fields: readonly ProfileField[], html: boolean): Field[] =>
    fields.map((field) => ({
        // Mastodon's names are plain text, so the HTML is only for federation.
        name: field.name,
        value: html ? field.value_html : field.value,
        verified_at: null,
    }));

/** The account's id in Versia, the URL its User entity is fetched from. */
const userUri = (ctx: Context, row: AccountRow) => {
    if (row.domain === null) return ctx.urls.url`/.versia/v0.6/entities/User/${row.id}`;

    if (row.remote_id === null) throw new Error(`Remote account ${row.id} has no remote id`);
    return `https://${row.domain}/.versia/v0.6/entities/User/${encodeURIComponent(row.remote_id)}`;
};

/** Midnight UTC on the day of `date`, which is all Mastodon shows of when accounts were made. */
const midnight = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** An account as anyone sees it, with its roles, highest first. */
export const renderAccount = (
    ctx: Context,
    row: AccountRow,
    roles: readonly RoleRow[],
): Account => {
    const avatar = ctx.urls.url`/accounts/${row.id}/avatar.png`;
    const header = ctx.urls.url`/accounts/${row.id}/header.png`;
    const local = row.domain === null;

    return {
        id: row.id,
        username: row.username,
        acct: local ? row.username : `${row.username}@${row.domain}`,
        // Versia users have no profile page of their own to link to.
        url: local ? ctx.urls.url`/@${row.username}` : null,
        uri: userUri(ctx, row),
        display_name: row.display_name,
        note: row.note_html,
        avatar,
        avatar_static: avatar,
        avatar_description: "",
        header,
        header_static: header,
        header_description: "",
        locked: row.locked,
        fields: renderFields(row.fields, true),
        emojis: [],
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
        // Only the roles shown on profiles. Remote accounts have none here.
        roles: local
            ? roles.filter((role) => role.visible)
                .map((role) => ({ id: role.id, name: role.name, color: role.color }))
            : null,
        // Verso has no collections, so nobody can feature anyone.
        feature_approval: { automatic: [], manual: [], current_user: "denied" },
    };
};

/**
 * An account as its owner sees it, with the settings they can change, its roles, highest first,
 * and everything it may do.
 */
export const renderCredentialAccount = (
    ctx: Context,
    row: AccountRow,
    roles: readonly RoleRow[],
    permissions: Iterable<Permission>,
): CredentialAccount => ({
    ...renderAccount(ctx, row, roles),
    source: {
        note: row.note,
        fields: renderFields(row.fields, false),
        privacy: row.default_visibility,
        sensitive: row.default_sensitive,
        language: row.default_language,
        follow_requests_count: 0,
        hide_collections: row.hide_collections,
        discoverable: row.discoverable,
        indexable: row.indexable,
        attribution_domains: [],
        // Verso doesn't restrict quotes.
        quote_policy: "public",
    },
    role: renderRole(roles, permissions),
});

/** The viewer's relationship with the account `id`: none at all, until follows, blocks and mutes. */
export const renderRelationship = (id: string): Relationship => ({
    id,
    following: false,
    showing_reblogs: false,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    muting_expires_at: null,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: "",
});
