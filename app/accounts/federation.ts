/**
 * Local accounts as Versia shows them to other instances.
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./accounts.ts";
import type { TextFormat } from "./tables.ts";

/** Text as its owner wrote it, and as HTML, so each instance can show whichever it can. */
const text = (format: TextFormat, written: string, html: string): v0_6.ContentFormat => ({
    [format]: { content: written, remote: false },
    "text/html": { content: html, remote: false },
});

/** A picture Verso serves, given by its URL. */
const picture = (url: string): v0_6.ContentFormat => ({
    "image/png": { content: url, remote: true },
});

/** A local account as a Versia User. */
const renderVersiaUser = (ctx: Context, row: AccountRow): v0_6.User => ({
    type: "User",
    id: row.id,
    created_at: row.created_at.toISOString(),
    username: row.username,
    display_name: row.display_name === "" ? undefined : row.display_name,
    bio: row.note === "" ? undefined : text(row.note_format, row.note, row.note_html),
    fields: row.fields.map((field) => ({
        key: text(field.format, field.name, field.name_html),
        value: text(field.format, field.value, field.value_html),
    })),
    avatar: picture(ctx.urls.url`/accounts/${row.id}/avatar.png`),
    header: picture(ctx.urls.url`/accounts/${row.id}/header.png`),
    manually_approves_followers: row.locked,
    indexable: row.indexable,
});

/** The local user with this id, or `undefined` if there is none. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return row?.domain === null ? row : undefined;
};

/**
 * A local user's collection, empty until the notes and follows that fill it arrive in step 8.
 * Limits from 1 to 40 must work; step 8 decides what to do with others.
 */
const emptyCollection: CollectionProvider = async (ctx, id) => {
    const row = await localUser(ctx, id);
    return row && { author: row.id, total: 0, items: [] };
};

/**
 * Users: local ones, fetched by other instances, with their collections, the notes they wrote and
 * pinned as entities, and who follows them and who they follow as references.
 * @see https://versia.pub/entities/user
 */
export const userType: EntityType<v0_6.User> = {
    type: "User",
    schema: v0_6.User,
    find: async (ctx, id) => {
        const row = await localUser(ctx, id);
        return row && renderVersiaUser(ctx, row);
    },
    collections: {
        outbox: emptyCollection,
        featured: emptyCollection,
        followers: emptyCollection,
        following: emptyCollection,
    },
};
