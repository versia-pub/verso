import { Status } from "@versia/client-api";
import { blockedSubquery } from "../graph/blocks.ts";
import { followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import { renderStatuses } from "./render.ts";
import { homePage, publicPage } from "./timeline_queries.ts";

/**
 * Which public statuses to give. `local` wins over `remote`, as on Mastodon. Verso has no media
 * yet, so asking only for statuses with media gives none.
 * @see https://docs.joinmastodon.org/methods/timelines/#public
 */
const PublicQuery = PageQuery({ default: 20, max: 40 }).extend({
    local: Flag.default(false),
    remote: Flag.default(false),
    only_media: Flag.default(false),
});

/**
 * Timelines: the notes of the accounts someone follows, found when they are read rather than
 * written out to each follower, and everyone's public notes.
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
                blockedSubquery(ctx, viewer.accountId),
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
            if (query.only_media) return { status: 200, body: [], cursors: {} };

            const origin = query.local ? "local" : query.remote ? "remote" : "all";
            const viewerId = viewer?.accountId ?? null;
            const blocked = viewerId === null ? null : blockedSubquery(ctx, viewerId);
            const notes = await publicPage(ctx, origin, blocked, query);
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewerId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
];
