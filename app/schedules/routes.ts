import { ScheduledStatus } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { renderScheduled } from "./render.ts";
import { findScheduled, scheduledPage } from "./schedule_queries.ts";
import { reschedule, unschedule } from "./schedules.ts";

/** A time to post a status at. */
const DateTime = z.iso.datetime({ offset: true }).transform((at) => new Date(at));

/** When to post a new status, if later: empty or `null` for now. */
export const ScheduledAt = z.union([
    z.literal("").transform(() => undefined),
    z.null().transform(() => undefined),
    DateTime,
]).optional().meta({
    description: "Datetime at which to schedule a status. Providing this parameter will cause " +
        "ScheduledStatus to be returned instead of Status. Must be at least 5 minutes in the " +
        "future.",
});

const ScheduledId = z.object({
    id: z.string().meta({ description: "The ID of the ScheduledStatus in the database." }),
});

const read = { require: "user", scope: "read:statuses", permission: "read:note" } as const;

const write = { require: "user", scope: "write:statuses", permission: "owner:note" } as const;

const docs = "https://docs.joinmastodon.org/methods/scheduled_statuses";

/** The viewer's scheduled statuses. */
export const scheduledRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/scheduled_statuses",
        summary: "View scheduled statuses",
        docs: `${docs}/#get`,
        tags: ["statuses"],
        auth: read,
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(ScheduledStatus) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await scheduledPage(ctx, viewer.accountId, query);

            return {
                status: 200,
                body: await renderScheduled(ctx, rows),
                cursors: cursorsOf(rows, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/scheduled_statuses/:id",
        summary: "View a single scheduled status",
        docs: `${docs}/#get-one`,
        tags: ["statuses"],
        auth: read,
        params: ScheduledId,
        responses: { 200: ScheduledStatus },
        handler: async (ctx, { params, viewer }) => {
            const row = await findScheduled(ctx, viewer.accountId, params.id);
            if (row === undefined) throw new NotFound();

            return { status: 200, body: (await renderScheduled(ctx, [row]))[0] };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/scheduled_statuses/:id",
        summary: "Update a scheduled status's publishing date",
        docs: `${docs}/#update`,
        tags: ["statuses"],
        auth: write,
        params: ScheduledId,
        body: z.object({
            scheduled_at: DateTime.meta({
                description: "Datetime at which the status will be published. Must be at least " +
                    "5 minutes into the future.",
            }),
        }),
        responses: { 200: ScheduledStatus },
        handler: async (ctx, { params, body, viewer }) => {
            const row = await reschedule(ctx, viewer.accountId, params.id, body.scheduled_at);
            if (row === undefined) throw new NotFound();

            return { status: 200, body: (await renderScheduled(ctx, [row]))[0] };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/scheduled_statuses/:id",
        summary: "Cancel a scheduled status",
        docs: `${docs}/#cancel`,
        tags: ["statuses"],
        auth: write,
        params: ScheduledId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await unschedule(ctx, viewer.accountId, params.id)) throw new NotFound();

            return { status: 200, body: {} };
        },
    }),
];
