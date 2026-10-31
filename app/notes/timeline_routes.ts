import { Status } from "@versia/client-api";
import { z } from "zod";
import { viewerHidden } from "../graph/hidden.ts";
import { NotFound } from "../http/errors.ts";
import { findList } from "../lists/list_queries.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Paged } from "../http/responses.ts";
import { Flag, Strings } from "../http/schemas.ts";
import { renderStatuses } from "./render.ts";
import { hashtagPage, homePage, listPage, type Origin, publicPage } from "./timeline_queries.ts";
import { homeSourcesOf, listSourcesOf } from "./timeline_sources.ts";

/**
 * Which public statuses to return. `local` wins over `remote`, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/timelines/#public
 */
const PublicQuery = PageQuery({ default: 20, max: 40 }).extend({
    local: Flag.default(false),
    remote: Flag.default(false),
    only_media: Flag.default(false),
});

/** Where the statuses `query` asks for are from: here only, other instances only, or both. */
const originOf = (query: z.output<typeof PublicQuery>): Origin =>
    query.local ? "local" : query.remote ? "remote" : "all";

/** How many hashtags each of `any`, `all` and `none` may have, as on Mastodon. */
const hashtagsPerList = 4;

/** Hashtags, as statuses keep them: without their `#`, and in lower case. */
const Hashtags = Strings.transform((names) =>
    names.map((name) => name.replace(/^#/, "").toLowerCase()).slice(0, hashtagsPerList)
).default([]);

/**
 * Which statuses of a hashtag's timeline to return, as Mastodon describes them.
 * @see https://docs.joinmastodon.org/methods/timelines/#tag
 */
const HashtagQuery = PublicQuery.extend({
    any: Hashtags.meta({
        description: "Return statuses that contain any of these additional tags.",
    }),
    all: Hashtags.meta({
        description: "Return statuses that contain all of these additional tags.",
    }),
    none: Hashtags.meta({
        description: "Return statuses that contain none of these additional tags.",
    }),
});

/**
 * Timelines: the statuses of the accounts someone follows, assembled when the timeline is read
 * rather than written out to each follower, and everyone's public statuses.
 */
export const timelineRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/timelines/home",
        summary: "View home timeline",
        description: "View statuses from followed users and hashtags.",
        docs: "https://docs.joinmastodon.org/methods/timelines/#home",
        tags: ["timelines"],
        auth: { require: "user", scope: "read:statuses", permission: "read:note" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const notes = await homePage(
                ctx,
                viewer.accountId,
                homeSourcesOf(ctx, viewer.accountId),
                query,
            );
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewer.accountId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/timelines/public",
        summary: "View public timeline",
        description: "View public statuses.",
        docs: "https://docs.joinmastodon.org/methods/timelines/#public",
        tags: ["timelines"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        query: PublicQuery,
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const notes = await publicPage(
                ctx,
                originOf(query),
                viewerHidden(ctx, viewerId),
                query,
                query.only_media,
            );
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewerId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/timelines/tag/:hashtag",
        summary: "View hashtag timeline",
        description: "View public statuses containing the given hashtag.",
        docs: "https://docs.joinmastodon.org/methods/timelines/#tag",
        tags: ["timelines"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: z.object({
            hashtag: z.string().meta({
                description: "The name of the hashtag (not including the # symbol).",
            }),
        }),
        query: HashtagQuery,
        responses: { 200: Paged(Status) },
        handler: async (ctx, { params, query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const hashtag = params.hashtag.toLowerCase();
            const tags = {
                any: [hashtag, ...query.any.filter((name) => name !== hashtag)]
                    .slice(0, hashtagsPerList),
                all: query.all,
                none: query.none,
            };

            const notes = await hashtagPage(
                ctx,
                tags,
                originOf(query),
                viewerHidden(ctx, viewerId),
                query,
                query.only_media,
            );
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewerId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/timelines/list/:list_id",
        summary: "View list timeline",
        description: "View statuses in the given list timeline.",
        docs: "https://docs.joinmastodon.org/methods/timelines/#list",
        tags: ["timelines"],
        auth: { require: "user", scope: "read:lists", permission: "read:note" },
        params: z.object({
            list_id: z.string().meta({ description: "Local ID of the List in the database." }),
        }),
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { params, query, viewer }) => {
            const list = await findList(ctx, viewer.accountId, params.list_id);
            if (list === undefined) throw new NotFound();

            const notes = await listPage(ctx, viewer.accountId, listSourcesOf(ctx, list), query);
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewer.accountId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
];
