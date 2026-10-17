/**
 * Local accounts as Versia shows them to other instances.
 * @module
 */
import { v0_6 } from "@versia/protocol";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { versiaJson } from "../instances/versia_routes.ts";
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

/**
 * A user's collections: the notes they wrote and pinned, as entities, and who follows them and who
 * they follow, as references.
 * @see https://versia.pub/entities/user
 */
const collections = new Set(["outbox", "featured", "followers", "following"]);

/**
 * Which page of a collection to give. Limits from 1 to 40 must work; step 8, which fills the
 * collections, decides what to do with others.
 * @see https://versia.pub/api/endpoints
 */
const Page = z.object({
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().optional(),
});

/** The local user with this id. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    if (row?.domain !== null) throw new NotFound();

    return row;
};

/** Local users, fetched by other instances. */
export const userEntityRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/.versia/v0.6/entities/User/:id",
        summary: "A local user, for another instance",
        tags: ["versia"],
        signed: true,
        contentType: versiaJson,
        params: z.object({ id: v0_6.Id }),
        responses: { 200: v0_6.User },
        handler: async (ctx, { params }) => ({
            status: 200,
            body: renderVersiaUser(ctx, await localUser(ctx, params.id)),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/.versia/v0.6/entities/User/:id/collections/:name",
        summary: "A page of one of a local user's collections, for another instance",
        tags: ["versia"],
        signed: true,
        contentType: versiaJson,
        params: z.object({ id: v0_6.Id, name: z.string() }),
        query: Page,
        responses: { 200: z.union([v0_6.Collection, v0_6.URICollection]) },
        handler: async (ctx, { params }) => {
            const row = await localUser(ctx, params.id);
            if (!collections.has(params.name)) throw new NotFound();

            // Notes and follows arrive in step 8, which fills these in.
            return { status: 200, body: { author: row.id, total: 0, items: [] } };
        },
    }),
];
