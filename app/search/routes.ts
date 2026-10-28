import { Account, Search } from "@versia/client-api";
import { z } from "zod";
import type { AccountRow } from "../accounts/account_queries.ts";
import { publicAccountsOf } from "../accounts/public.ts";
import { HttpError } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Integer, Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import { searchAccounts } from "./accounts.ts";
import { renderHashtags, searchHashtags } from "./hashtags.ts";
import { searchStatuses } from "./statuses.ts";
import { isUrlQuery, resolveUrl } from "./urls.ts";

/**
 * The longest query Verso searches for, in characters, and the most results it skips, so a search
 * can't make it do unbounded work. Mastodon has neither.
 */
const maxQueryLength = 500;
const maxOffset = 10_000;

/**
 * What `/api/v1/accounts/search` accepts, as Mastodon describes it. Clients may request more than
 * 80 accounts, and get 80.
 * @see https://docs.joinmastodon.org/methods/accounts/#search
 */
const AccountSearchQuery = z.object({
    q: Text(maxQueryLength).meta({
        description: `Search query for accounts. At most ${maxQueryLength} characters.`,
    }),
    limit: Integer.pipe(z.int().min(0)).optional()
        .transform((asked) => Math.max(1, Math.min(asked ?? 40, 80)))
        .meta({
            description: "Maximum number of results. Defaults to 40 accounts. Max 80 accounts.",
        }),
    offset: Integer.pipe(z.int().min(0).max(maxOffset)).default(0)
        .meta({ description: `Skip the first n results. At most ${maxOffset}.` }),
    resolve: Flag.default(false).meta({
        description: "Attempt WebFinger lookup. Defaults to false. Use this when `q` is an exact " +
            "address.",
    }),
    following: Flag.default(false).meta({
        description: "Limit the search to users you are following. Defaults to false.",
    }),
});

/**
 * What `/api/v2/search` accepts, as Mastodon describes it. Clients may request more than 40 of each,
 * and get 40.
 * @see https://docs.joinmastodon.org/methods/search/#v2
 */
const SearchQuery = z.object({
    q: Text(maxQueryLength).meta({
        description: `The search query. At most ${maxQueryLength} characters.`,
    }),
    type: z.enum(["accounts", "hashtags", "statuses"]).optional().meta({
        description: "Specify whether to search for only `accounts`, `hashtags`, `statuses`.",
    }),
    resolve: Flag.default(false).meta({
        description: "Attempt WebFinger lookup, when `q` is an account's address, or look up " +
            "the account or status at a URL, when `q` is one. Defaults to false. Verso " +
            "looks up the Versia URLs it shows as accounts' and statuses' `uri`.",
    }),
    following: Flag.default(false).meta({
        description: "Only include accounts that the user is following? Defaults to false.",
    }),
    account_id: z.string().optional().meta({
        description: "If provided, will only return statuses authored by this account.",
    }),
    exclude_unreviewed: Flag.default(false).meta({
        description: "Filter out unreviewed tags? Verso doesn't review hashtags, so this changes " +
            "nothing.",
    }),
    max_id: z.string().optional().meta({
        description: "All results returned will be lesser than this ID. In effect, sets an upper " +
            "bound on results.",
    }),
    min_id: z.string().optional().meta({
        description:
            "Returns results immediately newer than this ID. In effect, sets a cursor at " +
            "this ID and paginates forward.",
    }),
    limit: Integer.pipe(z.int().min(0)).optional()
        .transform((asked) => Math.max(1, Math.min(asked ?? 20, 40)))
        .meta({
            description: "Maximum number of results to return, per type. Defaults to 20 results " +
                "per category. Max 40 results per category.",
        }),
    offset: Integer.pipe(z.int().min(0).max(maxOffset)).optional().meta({
        description: "Skip the first n results. Only applies when `type` is also present. At " +
            `most ${maxOffset}.`,
    }),
});

/** What a search found, rendered as `viewerId` sees it. */
const rendered = async (
    ctx: Context,
    viewerId: string | null,
    found: {
        readonly accounts: readonly AccountRow[];
        readonly statuses: readonly NoteRow[];
        readonly hashtags: readonly string[];
    },
): Promise<Search> => ({
    // In the order of `accounts`.
    accounts: [...(await publicAccountsOf(ctx, found.accounts)).values()],
    statuses: await renderStatuses(ctx, found.statuses, viewerId),
    hashtags: await renderHashtags(ctx, found.hashtags),
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
        auth: { require: "user", scope: "read:accounts", permission: "search" },
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
    defineRoute({
        method: "GET",
        path: "/api/v2/search",
        summary: "Perform a search",
        description: "Perform a search for content in accounts, statuses and hashtags with the " +
            "given parameters.\n\nAs on Mastodon, only signed-in users search statuses, or use " +
            "`resolve` or `offset`.",
        docs: "https://docs.joinmastodon.org/methods/search/#v2",
        tags: ["search"],
        auth: { require: "optional", scope: "read:search", permission: "search" },
        query: SearchQuery,
        responses: { 200: Search },
        handler: async (ctx, { query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            // Mastodon's errors.
            if (viewerId === null && query.offset !== undefined) {
                throw new HttpError(
                    401,
                    "Search queries pagination is not supported without authentication",
                );
            }
            if (viewerId === null && query.resolve) {
                throw new HttpError(
                    401,
                    "Search queries that resolve remote resources are not supported without " +
                        "authentication",
                );
            }

            const wants = (type: typeof query.type) =>
                query.type === undefined || query.type === type;
            const { limit } = query;
            const offset = query.type === undefined ? 0 : query.offset ?? 0;

            // A URL is all a search that resolves looks for, as on Mastodon: what it names, on the
            // first page, if it is of the type wanted.
            const q = query.q.trim();
            if (query.resolve && viewerId !== null && isUrlQuery(q)) {
                const found = offset === 0 ? await resolveUrl(ctx, q, viewerId) : undefined;
                const shown = found && wants(found.type) ? found : undefined;
                return {
                    status: 200,
                    body: await rendered(ctx, viewerId, {
                        accounts: shown?.type === "accounts" ? [shown.account] : [],
                        statuses: shown?.type === "statuses" ? [shown.note] : [],
                        hashtags: [],
                    }),
                };
            }

            const accounts = wants("accounts")
                ? await searchAccounts(ctx, {
                    query: query.q,
                    viewerId,
                    resolve: query.resolve,
                    following: query.following,
                    limit,
                    offset,
                })
                : [];
            const statuses = wants("statuses") && viewerId !== null
                ? await searchStatuses(ctx, {
                    query: query.q,
                    viewerId,
                    accountId: query.account_id ?? null,
                    minId: query.min_id ?? null,
                    maxId: query.max_id ?? null,
                    limit,
                    offset,
                })
                : [];
            const hashtags = wants("hashtags")
                ? await searchHashtags(ctx, { query: query.q, limit, offset })
                : [];

            return {
                status: 200,
                body: await rendered(ctx, viewerId, { accounts, statuses, hashtags }),
            };
        },
    }),
];
