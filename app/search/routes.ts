import { Account } from "@versia/client-api";
import { z } from "zod";
import { publicAccountsOf } from "../accounts/public.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Integer } from "../http/schemas.ts";
import { searchAccounts } from "./accounts.ts";

/**
 * What `/api/v1/accounts/search` accepts, as Mastodon describes it. Clients may request more than
 * 80 accounts, and get 80.
 * @see https://docs.joinmastodon.org/methods/accounts/#search
 */
const AccountSearchQuery = z.object({
    q: z.string().meta({ description: "Search query for accounts." }),
    limit: Integer.pipe(z.int().min(0)).optional()
        .transform((asked) => Math.max(1, Math.min(asked ?? 40, 80)))
        .meta({
            description: "Maximum number of results. Defaults to 40 accounts. Max 80 accounts.",
        }),
    offset: Integer.pipe(z.int().min(0)).default(0)
        .meta({ description: "Skip the first n results." }),
    resolve: Flag.default(false).meta({
        description: "Attempt WebFinger lookup. Defaults to false. Use this when `q` is an exact " +
            "address.",
    }),
    following: Flag.default(false).meta({
        description: "Limit the search to users you are following. Defaults to false.",
    }),
});

/**
 * Searching accounts, statuses and hashtags. Before the account routes, whose
 * `/api/v1/accounts/:id` would otherwise match `/api/v1/accounts/search`.
 */
export const searchRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/search",
        summary: "Search for matching accounts",
        description: "Search for matching accounts by username or display name.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#search",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:accounts", permission: "read:account" },
        query: AccountSearchQuery,
        responses: { 200: z.array(Account) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await searchAccounts(ctx, {
                query: query.q,
                viewerId: viewer.accountId,
                resolve: query.resolve,
                following: query.following,
                limit: query.limit,
                offset: query.offset,
            });
            // In the order of `rows`.
            return { status: 200, body: [...(await publicAccountsOf(ctx, rows)).values()] };
        },
    }),
];
