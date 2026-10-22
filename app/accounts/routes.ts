import { Account, CredentialAccount } from "@versia/client-api";
import { z } from "zod";
import { emojisOfAccounts } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Text } from "../http/schemas.ts";
import type { Limits } from "../kernel/config.ts";
import { countFollowRequests } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount } from "./account_queries.ts";
import { findAccountByAddress, parseAddress } from "./addresses.ts";
import { pictureRoutes } from "./picture_routes.ts";
import { updateProfile } from "./profile.ts";
import { publicAccount } from "./public.ts";
import { renderCredentialAccount } from "./render.ts";
import { rolesOf } from "./role_queries.ts";

const found = (row: AccountRow | undefined) => {
    if (row === undefined) throw new NotFound();
    return row;
};

/** The viewer's own account, with its roles, what it may do, and who asks to follow it. */
const ownAccount = async (ctx: Context, viewer: RouteViewer & { readonly accountId: string }) => {
    const row = found(await findAccount(ctx, viewer.accountId));
    return renderCredentialAccount(
        ctx,
        row,
        await rolesOf(ctx, row.id),
        renderEmojis((await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? []),
        await viewer.permissions(),
        await countFollowRequests(ctx, row.id),
    );
};

/**
 * What `update_credentials` changes, within `limits`. Avatars, headers and their descriptions,
 * attribution domains and quote policies are accepted, but not kept yet; Verso doesn't restrict
 * quotes.
 * @see https://docs.joinmastodon.org/methods/accounts/#update_credentials
 */
const credentialChanges = (limits: Limits) => {
    const ProfileField = z.object({
        name: Text(limits.field_name).default(""),
        value: Text(limits.field_value).default(""),
    });

    return z.object({
        display_name: Text(limits.display_name).optional(),
        note: Text(limits.note).optional(),
        locked: Flag.optional(),
        bot: Flag.optional(),
        discoverable: Flag.optional(),
        indexable: Flag.optional(),
        hide_collections: Flag.optional(),
        /** An array, or an object by index, as forms send it, in either case in order. */
        fields_attributes: z.union([
            z.array(ProfileField),
            z.record(z.string().regex(/^\d+$/), ProfileField).transform(Object.values),
        ])
            .refine((fields) => fields.length <= limits.fields, {
                error: `At most ${limits.fields} fields`,
            })
            .optional(),
        source: z.object({
            privacy: z.enum(["public", "unlisted", "private"]).optional(),
            sensitive: Flag.optional(),
            language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).optional(),
        }).optional(),
    });
};

/** Accounts, and the default pictures of accounts without their own. */
export const accountRoutes = (limits: Limits): readonly Route[] => [
    // Before `/api/v1/accounts/:id`, which would otherwise take these paths.
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/verify_credentials",
        summary: "The viewer's own account, with their settings",
        tags: ["accounts"],
        auth: { require: "user", scope: "profile" },
        responses: { 200: CredentialAccount },
        handler: async (ctx, { viewer }) => ({ status: 200, body: await ownAccount(ctx, viewer) }),
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v1/accounts/update_credentials",
        summary: "Changes the viewer's profile and settings",
        tags: ["accounts"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        body: credentialChanges(limits),
        responses: { 200: CredentialAccount },
        handler: async (ctx, { viewer, body }) => {
            await updateProfile(ctx, viewer.accountId, {
                displayName: body.display_name,
                note: body.note,
                fields: body.fields_attributes,
                locked: body.locked,
                bot: body.bot,
                discoverable: body.discoverable,
                indexable: body.indexable,
                hideCollections: body.hide_collections,
                defaultVisibility: body.source?.privacy,
                defaultSensitive: body.source?.sensitive,
                defaultLanguage: body.source?.language,
            });

            return { status: 200, body: await ownAccount(ctx, viewer) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/lookup",
        summary: "An account, by its username or WebFinger address",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        query: z.object({ acct: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { query, viewer }) => {
            const address = parseAddress(ctx, query.acct);
            if (address === undefined) throw new NotFound();

            // Anyone else could make Verso fetch from wherever they liked.
            const fetch = typeof viewer?.accountId === "string";
            const row = await findAccountByAddress(ctx, address, { fetch });

            return { status: 200, body: await publicAccount(ctx, found(row)) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id",
        summary: "An account",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        params: z.object({ id: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { params }) => ({
            status: 200,
            body: await publicAccount(ctx, found(await findAccount(ctx, params.id))),
        }),
    }),
    ...pictureRoutes(),
];
