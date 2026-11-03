import { Account, Relationship } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { endorsementPage } from "./endorsement_queries.ts";
import { endorse, unendorse } from "./endorsements.ts";
import { relationship } from "./relationships.ts";

/**
 * Features an account on the viewer's profile, or stops featuring it, at the path Mastodon names
 * the action by.
 */
const endorseRoute = (action: "pin" | "unpin", name: string) =>
    defineRoute({
        method: "POST",
        path: `/api/v1/accounts/:id/${name}`,
        ...action === "pin"
            ? {
                summary: "Feature account on your profile",
                description: "Add the given account to the user's featured profiles. (Featured " +
                    "profiles are currently shown on the user's own public profile.)",
            }
            : {
                summary: "Unfeature account from profile",
                description: "Remove the given account from the user's featured profiles.",
            },
        docs: `https://docs.joinmastodon.org/methods/accounts/#${name}`,
        tags: ["accounts"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        params: z.object({ id: z.string() }),
        responses: { 200: Relationship },
        handler: async (ctx, { params, viewer }) => {
            if (action === "pin") {
                const result = await endorse(ctx, viewer.accountId, params.id);
                if (result === "missing") throw new NotFound();
                if (result === "unfollowed") {
                    throw new Unprocessable(
                        "You must be already following the person you want to endorse",
                    );
                }
            } else if (!await unendorse(ctx, viewer.accountId, params.id)) {
                throw new NotFound();
            }

            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    });

export const endorsementRoutes: readonly Route[] = [
    endorseRoute("pin", "pin"),
    endorseRoute("unpin", "unpin"),
    // Mastodon 4.4 names them endorse and unendorse; the old names stay as aliases.
    endorseRoute("pin", "endorse"),
    endorseRoute("unpin", "unendorse"),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id/endorsements",
        summary: "Get account's endorsements",
        description: "Accounts that the given account is currently featuring on its profile.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#endorsements",
        tags: ["accounts"],
        auth: { require: "optional", scope: "read:accounts", permission: "read:account" },
        params: z.object({ id: z.string() }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query }) => {
            if (await findAccount(ctx, params.id) === undefined) throw new NotFound();

            const endorsements = await endorsementPage(ctx, params.id, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, endorsements.map((row) => row.account_id)),
                cursors: cursorsOf(endorsements, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/endorsements",
        summary: "View currently featured profiles",
        description: "Accounts that the user is currently featuring on their profile.",
        docs: "https://docs.joinmastodon.org/methods/endorsements/#get",
        tags: ["endorsements"],
        auth: { require: "user", scope: "read:accounts", permission: "owner:account" },
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { query, viewer }) => {
            const endorsements = await endorsementPage(ctx, viewer.accountId, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, endorsements.map((row) => row.account_id)),
                cursors: cursorsOf(endorsements, query, (row) => row.id),
            };
        },
    }),
];
