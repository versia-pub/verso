/**
 * Turns accounts into the client API's entities.
 * @module
 */
import type { Account, CredentialAccount, Field, Role } from "@versia/client-api";
import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { AccountsTable, ProfileField } from "./tables.ts";

/** An account, with the domain of its instance, or `null` for this one. */
export type AccountRow = Selectable<AccountsTable> & { readonly domain: string | null };

/** The account `id`, with its instance's domain, or `undefined` if there is none. */
export const findAccount = (ctx: Context, id: string): Promise<AccountRow | undefined> =>
    ctx.db.selectFrom("accounts")
        .leftJoin("instances", "instances.id", "accounts.instance_id")
        .selectAll("accounts")
        .select("instances.domain")
        .where("accounts.id", "=", id)
        .executeTakeFirst();

/** The role Mastodon gives users without one, which grants nothing. */
const everyone: Role = {
    id: "-99",
    name: "",
    color: "",
    permissions: "0",
    highlighted: false,
    collection_limit: 0,
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

/** An account as anyone sees it. */
export const renderAccount = (ctx: Context, row: AccountRow): Account => {
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
        // Roles arrive with permissions; remote accounts have none here.
        roles: local ? [] : null,
        // Verso has no collections, so nobody can feature anyone.
        feature_approval: { automatic: [], manual: [], current_user: "denied" },
    };
};

/** An account as its owner sees it, with the settings they can change. */
export const renderCredentialAccount = (ctx: Context, row: AccountRow): CredentialAccount => ({
    ...renderAccount(ctx, row),
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
    role: everyone,
});
