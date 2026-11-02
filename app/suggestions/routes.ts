import { Suggestion } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Integer } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import { dismissSuggestion, suggestionsFor } from "./suggestions.ts";

/** What older apps call the first source of a suggestion. */
const legacySource: Partial<Record<Suggestion["sources"][number], Suggestion["source"]>> = {
    featured: "staff",
    most_followed: "global",
    most_interactions: "global",
    similar_to_recently_followed: "past_interactions",
    friends_of_friends: "past_interactions",
};

/** The accounts suggested to follow, from the instance's picks and from who users follow. */
export const suggestionRoutes = (
    instance: Pick<Config["instance"], "suggested_accounts">,
): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/api/v2/suggestions",
        summary: "View follow suggestions",
        description: "Accounts that are promoted by staff, or that the user has had past " +
            "positive interactions with, but is not yet following.",
        docs: "https://docs.joinmastodon.org/methods/suggestions/#v2",
        tags: ["suggestions"],
        auth: { require: "user", scope: "read:accounts", permission: "owner:account" },
        query: z.object({
            offset: Integer.pipe(z.int().min(0)).default(0).meta({
                description: "Skip the first n results.",
            }),
            limit: Integer.pipe(z.int().min(0)).optional()
                .transform((asked) => Math.max(1, Math.min(asked ?? 40, 80)))
                .meta({
                    description: "Maximum number of results to return. Defaults to 40. Max 80.",
                }),
        }),
        responses: { 200: z.array(Suggestion) },
        handler: async (ctx, { query, viewer }) => {
            const suggested = await suggestionsFor(
                ctx,
                viewer.accountId,
                instance.suggested_accounts,
                query,
            );
            const accounts = new Map(
                (await publicAccounts(ctx, suggested.map((one) => one.accountId)))
                    .map((account) => [account.id, account]),
            );

            return {
                status: 200,
                body: suggested.flatMap(({ accountId, sources }) => {
                    const account = accounts.get(accountId);
                    const [first] = sources;
                    return account === undefined ? [] : [{
                        source: first === undefined ? null : legacySource[first] ?? null,
                        sources: [...sources],
                        account,
                    }];
                }),
            };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/suggestions/:id",
        summary: "Remove a suggestion",
        description: "Remove an account from follow suggestions.",
        docs: "https://docs.joinmastodon.org/methods/suggestions/#remove",
        tags: ["suggestions"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        params: z.object({
            id: z.string().meta({ description: "The ID of the Account in the database." }),
        }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            await dismissSuggestion(ctx, viewer.accountId, params.id);
            return { status: 200, body: {} };
        },
    }),
];
