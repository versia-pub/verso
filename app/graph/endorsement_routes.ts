import { Account, Relationship } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { endorsementPage } from "./endorsement_queries.ts";
import { endorse, unendorse } from "./endorsements.ts";
import { relationship } from "./relationships.ts";

/** Features an account on the viewer's profile, or stops featuring it. */
const endorseRoute = (action: "pin" | "unpin") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/accounts/:id/${action}`,
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
        docs: `https://docs.joinmastodon.org/methods/accounts/#${action}`,
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
    endorseRoute("pin"),
    endorseRoute("unpin"),
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
