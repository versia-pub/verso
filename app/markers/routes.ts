import { Markers } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, type Route } from "../http/route.ts";
import { Strings } from "../http/schemas.ts";
import { type MarkerRow, markersOf, setMarker } from "./marker_queries.ts";
import { renderMarkers } from "./render.ts";
import { isTimeline, timelines } from "./tables.ts";

/** Where the user read up to in a timeline. */
const Position = z.object({
    last_read_id: z.string().min(1).meta({
        description: "ID of the last status or notification read.",
    }),
}).optional();

const docs = "https://docs.joinmastodon.org/methods/markers";

export const markerRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/markers",
        summary: "Get saved timeline positions",
        description: "Get current positions in timelines.",
        docs: `${docs}/#get`,
        tags: ["markers"],
        auth: { require: "user", scope: "read:statuses", permission: "owner:account" },
        query: z.object({
            timeline: Strings.transform((names) => names.filter(isTimeline)).optional().meta({
                description: "Specify the timeline(s) for which markers should be fetched. " +
                    "Possible values: `home`, `notifications`. If not provided, an empty " +
                    "object will be returned.",
            }),
        }),
        responses: { 200: Markers },
        handler: async (ctx, { query, viewer }) => ({
            status: 200,
            body: renderMarkers(await markersOf(ctx, viewer.accountId, query.timeline ?? [])),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/markers",
        summary: "Save your position in a timeline",
        description: "Save current position in timeline.",
        docs: `${docs}/#create`,
        tags: ["markers"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:account" },
        body: z.object({ home: Position, notifications: Position }),
        responses: { 200: Markers },
        handler: async (ctx, { body, viewer }) => {
            const set = await ctx.transaction(async (tx) => {
                const rows: MarkerRow[] = [];
                for (const timeline of timelines) {
                    const position = body[timeline];
                    if (position === undefined) continue;

                    rows.push(
                        await setMarker(tx, viewer.accountId, timeline, position.last_read_id),
                    );
                }

                return rows;
            });

            return { status: 200, body: renderMarkers(set) };
        },
    }),
];
