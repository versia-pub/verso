import { Account, CredentialAccount } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount, findLocalAccount } from "./accounts.ts";
import { identicon, identiconBanner } from "./identicon.ts";
import { renderAccount, renderCredentialAccount } from "./render.ts";

const AccountId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/**
 * Only local accounts are shown for now: remote ones arrive with federation, along with the
 * sanitising of their HTML.
 */
const shown = (row: AccountRow | undefined) => {
    if (row === undefined || row.domain !== null) throw new NotFound();
    return row;
};

/**
 * The username in `user`, `@user` or `user@domain`, if the domain is this instance's. Accounts on
 * other instances aren't looked up yet.
 */
const localUsername = (ctx: Context, acct: string) => {
    const [username, domain, ...rest] = acct.replace(/^@/, "").split("@");
    const ours = domain === undefined || domain.toLowerCase() === new URL(ctx.urls.origin).hostname;

    return rest.length === 0 && ours ? username : undefined;
};

/** A day: the pictures never change, but how they are drawn might. */
const pictureMaxAge = 24 * 60 * 60;

/**
 * Accounts, and the default pictures of accounts without their own. Timelines load many pictures,
 * so those have no rate limit.
 */
export const accountRoutes: readonly Route[] = [
    // Before `/api/v1/accounts/:id`, which would otherwise take these paths.
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/verify_credentials",
        summary: "The viewer's own account, with their settings",
        tags: ["accounts"],
        auth: { require: "user", scope: "profile" },
        responses: { 200: CredentialAccount },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: renderCredentialAccount(ctx, shown(await findAccount(ctx, viewer.accountId))),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/lookup",
        summary: "An account, by its username or WebFinger address",
        tags: ["accounts"],
        query: z.object({ acct: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { query }) => {
            const username = localUsername(ctx, query.acct);
            if (username === undefined) throw new NotFound();

            return {
                status: 200,
                body: renderAccount(ctx, shown(await findLocalAccount(ctx, username))),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id",
        summary: "An account",
        tags: ["accounts"],
        params: z.object({ id: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { params }) => ({
            status: 200,
            body: renderAccount(ctx, shown(await findAccount(ctx, params.id))),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/accounts/:id/avatar.png",
        summary: "An account's default avatar",
        tags: ["accounts"],
        maxAge: pictureMaxAge,
        rateLimit: false,
        params: AccountId,
        responses: { 200: Binary("image/png") },
        handler: async (_, { params }) => ({ status: 200, file: await identicon(params.id) }),
    }),
    defineRoute({
        method: "GET",
        path: "/accounts/:id/header.png",
        summary: "An account's default header",
        tags: ["accounts"],
        maxAge: pictureMaxAge,
        rateLimit: false,
        params: AccountId,
        responses: { 200: Binary("image/png") },
        handler: async (_, { params }) => ({ status: 200, file: await identiconBanner(params.id) }),
    }),
];
