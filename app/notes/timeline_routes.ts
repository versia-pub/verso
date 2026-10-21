import { Status } from "@versia/client-api";
import { followedIds } from "../graph/follows.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { renderStatuses } from "./render.ts";
import { homePage } from "./timeline_queries.ts";

/**
 * Timelines: the notes of the accounts someone follows, found when they are read rather than
 * written out to each follower.
 */
export const timelineRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/timelines/home",
        summary: "The viewer's statuses and those of the accounts they follow, newest first",
        tags: ["timelines"],
        auth: { require: "user", scope: "read:statuses", permission: "read:note" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const notes = await homePage(
                ctx,
                viewer.accountId,
                followedIds(ctx, viewer.accountId),
                query,
            );
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewer.accountId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
];
