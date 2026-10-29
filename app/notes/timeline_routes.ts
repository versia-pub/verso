import { Status } from "@versia/client-api";
import { z } from "zod";
import { hiddenFrom, viewerHidden } from "../graph/hidden.ts";
import { followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Flag, Strings } from "../http/schemas.ts";
import { renderStatuses } from "./render.ts";
import { hashtagPage, homePage, type Origin, publicPage } from "./timeline_queries.ts";

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
        summary:
            "The viewer's statuses and those of the accounts they follow, and their shares, newest first",
        tags: ["timelines"],
        auth: { require: "user", scope: "read:statuses", permission: "read:note" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const notes = await homePage(
                ctx,
                viewer.accountId,
                followedSubquery(ctx, viewer.accountId),
                sharingSubquery(ctx, viewer.accountId),
                hiddenFrom(ctx, viewer.accountId),
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
        summary: "Public statuses, here or from other instances, newest first",
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
        description: "View public statuses containing the given hashtag.\n\nAs on Mastodon, " +
            `\`any\`, \`all\` and \`none\` each take at most ${hashtagsPerList} hashtags, the ` +
            "first of `any` being the hashtag itself.",
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
];
