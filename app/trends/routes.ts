import { Status, Tag } from "@versia/client-api";
import { z } from "zod";
import { offsetsOf } from "../http/paging.ts";
import { Offset } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Integer } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import { renderStatuses } from "../notes/render.ts";
import { renderHashtags } from "../search/hashtags.ts";
import { approvedTrendingStatuses, approvedTrendingTags } from "./trend_queries.ts";

/** Which page of a trending list to return, by offset, and how long it is at most. */
const TrendQuery = (limit: { readonly default: number; readonly max: number }) =>
    z.object({
        offset: Integer.pipe(z.int().min(0)).default(0).meta({
            description: "Skip the first n results.",
        }),
        limit: Integer.pipe(z.int().min(0)).optional()
            .transform((asked) => Math.max(1, Math.min(asked ?? limit.default, limit.max)))
            .meta({
                description: `Maximum number of results to return. Defaults to ${limit.default}. ` +
                    `Max ${limit.max}.`,
            }),
    });

const tagsQuery = TrendQuery({ default: 10, max: 20 });

/** What is trending, which `instance` says whether to show, and whether admins approved. */
export const trendRoutes = (
    instance: Pick<Config["instance"], "show_trends" | "trendable_by_default">,
): readonly Route[] => {
    const trendingTags = (path: string) =>
        defineRoute({
            method: "GET",
            path,
            summary: "View trending tags",
            description: "Tags that are being used more frequently within the past week.",
            docs: "https://docs.joinmastodon.org/methods/trends/#tags",
            tags: ["trends"],
            auth: { require: "optional", permission: "read:note" },
            query: tagsQuery,
            responses: { 200: Offset(Tag) },
            handler: async (ctx, { query, viewer }) => {
                const names = instance.show_trends
                    ? await approvedTrendingTags(
                        ctx,
                        instance.trendable_by_default,
                        query.limit,
                        query.offset,
                    )
                    : [];

                return {
                    status: 200,
                    body: await renderHashtags(ctx, names, viewer?.accountId ?? null),
                    offsets: offsetsOf(names.length, query.offset, query.limit),
                };
            },
        });

    return [
        trendingTags("/api/v1/trends/tags"),
        // The route Mastodon had before it had `/tags`, which apps still use.
        trendingTags("/api/v1/trends"),
        defineRoute({
            method: "GET",
            path: "/api/v1/trends/statuses",
            summary: "View trending statuses",
            description: "Statuses that have been interacted with more than others.",
            docs: "https://docs.joinmastodon.org/methods/trends/#statuses",
            tags: ["trends"],
            auth: { require: "optional", permission: "read:note" },
            query: TrendQuery({ default: 20, max: 40 }),
            responses: { 200: Offset(Status) },
            handler: async (ctx, { query, viewer }) => {
                const viewerId = viewer?.accountId ?? null;
                const notes = instance.show_trends
                    ? await approvedTrendingStatuses(
                        ctx,
                        instance.trendable_by_default,
                        viewerId,
                        query.limit,
                        query.offset,
                    )
                    : [];

                return {
                    status: 200,
                    body: await renderStatuses(ctx, notes, viewerId),
                    offsets: offsetsOf(notes.length, query.offset, query.limit),
                };
            },
        }),
    ];
};
