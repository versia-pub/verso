import { Status, Tag, TrendsLink } from "@versia/client-api";
import { z } from "zod";
import { viewerHidden } from "../graph/hidden.ts";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, offsetsOf, PageQuery } from "../http/paging.ts";
import { Offset, Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Integer } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import { TimelinesAccess } from "../kernel/config_sections.ts";
import { visibleOrigin } from "../notes/feed_access.ts";
import { renderStatuses } from "../notes/render.ts";
import { renderHashtags } from "../search/hashtags.ts";
import { linkPage } from "./link_queries.ts";
import { approvedTrendingCards, renderTrendingLinks } from "./links.ts";
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

const trendQuery = TrendQuery({ default: 10, max: 20 });

/** Which link's statuses to return, and which of them. */
const LinkTimelineQuery = PageQuery({ default: 20, max: 40 }).extend({
    url: z.string().meta({ description: "The URL of the trending article." }),
});

/** What is trending, which `instance` says whether to show, and whether admins approved. */
export const trendRoutes = (
    instance: Pick<Config["instance"], "show_trends" | "trendable_by_default">,
    access: Pick<Config["timelines_access"], "topic_feeds"> = TimelinesAccess.parse({}),
): readonly Route[] => {
    const trendingTags = (path: string, deprecated?: string) =>
        defineRoute({
            method: "GET",
            path,
            deprecated,
            summary: "View trending tags",
            description: "Tags that are being used more frequently within the past week.",
            docs: "https://docs.joinmastodon.org/methods/trends/#tags",
            tags: ["trends"],
            auth: { require: "optional", permission: "read:note" },
            query: trendQuery,
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
        trendingTags("/api/v1/trends", "2022-03-30"),
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
        defineRoute({
            method: "GET",
            path: "/api/v1/trends/links",
            summary: "View trending links",
            description: "Links that have been shared more than others.",
            docs: "https://docs.joinmastodon.org/methods/trends/#links",
            tags: ["trends"],
            auth: { require: "optional", permission: "read:note" },
            query: trendQuery,
            responses: { 200: Offset(TrendsLink) },
            handler: async (ctx, { query, viewer }) => {
                const cards = instance.show_trends
                    ? (await approvedTrendingCards(ctx, instance.trendable_by_default))
                        .slice(query.offset, query.offset + query.limit)
                    : [];

                return {
                    status: 200,
                    body: await renderTrendingLinks(ctx, cards, viewer?.accountId ?? null),
                    offsets: offsetsOf(cards.length, query.offset, query.limit),
                };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/timelines/link",
            summary: "View link timeline",
            description:
                "View public statuses containing a link to the specified currently-trending " +
                "article. This only lists statuses from people who have opted in to discoverability " +
                "features.",
            docs: "https://docs.joinmastodon.org/methods/timelines/#link",
            tags: ["timelines"],
            auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
            query: LinkTimelineQuery,
            responses: { 200: Paged(Status) },
            handler: async (ctx, { query, viewer }) => {
                const viewerId = viewer?.accountId ?? null;

                // Mastodon decides it by the `local` and `remote` a client sends, which Verso
                // doesn't use.
                const origin = await visibleOrigin(access.topic_feeds, "all", viewer);
                const card = instance.show_trends
                    ? (await approvedTrendingCards(ctx, instance.trendable_by_default))
                        .find((trending) => trending.url === query.url)
                    : undefined;
                if (card === undefined) throw new NotFound();

                const notes = origin === undefined
                    ? []
                    : await linkPage(ctx, card.id, viewerHidden(ctx, viewerId), query, origin);

                return {
                    status: 200,
                    body: await renderStatuses(ctx, notes, viewerId),
                    cursors: cursorsOf(notes, query, (note) => note.id),
                };
            },
        }),
    ];
};
