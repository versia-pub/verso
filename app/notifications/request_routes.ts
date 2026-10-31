import { NotificationRequest } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Ids } from "../http/schemas.ts";
import { renderRequests } from "./render.ts";
import { findRequests, requestPage } from "./request_queries.ts";
import { acceptRequests, dismissRequests } from "./requests.ts";

/** How many requests may be accepted or dismissed at once, which Mastodon doesn't limit. */
const bulkLimit = 100;

const RequestId = z.object({
    id: z.string().meta({ description: "The ID of the Notification in the database." }),
});

const RequestIds = z.object({
    id: Ids(bulkLimit).meta({
        description: "The IDs of the notification requests in the database.",
    }),
});

const read = {
    require: "user",
    scope: "read:notifications",
    permission: "owner:notification",
} as const;

const write = {
    require: "user",
    scope: "write:notifications",
    permission: "owner:notification",
} as const;

const docs = "https://docs.joinmastodon.org/methods/notifications";

/** Notification requests, with the bulk paths before `:id`, which would take them. */
export const notificationRequestRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications/requests",
        summary: "Get all notification requests",
        description:
            "Notification requests for notifications filtered by the user's policy. This " +
            "API returns Link headers containing links to the next/previous page.",
        docs: `${docs}/#get-requests`,
        tags: ["notifications"],
        auth: read,
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(NotificationRequest) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await requestPage(ctx, viewer.accountId, query);

            return {
                status: 200,
                body: await renderRequests(ctx, rows, viewer.accountId),
                cursors: cursorsOf(rows, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/requests/accept",
        summary: "Accept multiple notification requests",
        description: "Accepts multiple notification requests, which merges the filtered " +
            "notifications from those users back into the main notifications and accepts any " +
            "future notification from them.",
        docs: `${docs}/#accept-multiple-requests`,
        tags: ["notifications"],
        auth: write,
        body: RequestIds,
        responses: { 200: z.object({}) },
        handler: async (ctx, { body, viewer }) => {
            const requests = await findRequests(ctx, viewer.accountId, body.id);
            await acceptRequests(ctx, viewer.accountId, requests);

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/requests/dismiss",
        summary: "Dismiss multiple notification requests",
        description: "Dismiss multiple notification requests, which hides them and prevent them " +
            "from contributing to the pending notification requests count.",
        docs: `${docs}/#dismiss-multiple-requests`,
        tags: ["notifications"],
        auth: write,
        body: RequestIds,
        responses: { 200: z.object({}) },
        handler: async (ctx, { body, viewer }) => {
            const requests = await findRequests(ctx, viewer.accountId, body.id);
            await dismissRequests(ctx, viewer.accountId, requests);

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications/requests/merged",
        summary: "Check if accepted notification requests have been merged",
        description: "Check whether accepted notification requests have been merged.\n\n" +
            "Accepting notification requests schedules a background job to merge the filtered " +
            "notifications back into the normal notification list. When that process has " +
            "finished, the client should refresh the notifications list at its earliest " +
            "convenience. This is communicated by the `notifications_merged` streaming event " +
            "but can also be polled using this endpoint.",
        docs: `${docs}/#requests-merged`,
        tags: ["notifications"],
        auth: read,
        responses: { 200: z.object({ merged: z.boolean() }) },
        // Verso merges them as they are accepted.
        handler: () => Promise.resolve({ status: 200, body: { merged: true } }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications/requests/:id",
        summary: "Get a single notification request",
        description: "View information about a notification request with a given ID.",
        docs: `${docs}/#get-one-request`,
        tags: ["notifications"],
        auth: read,
        params: RequestId,
        responses: { 200: NotificationRequest },
        handler: async (ctx, { params, viewer }) => {
            const rows = await findRequests(ctx, viewer.accountId, [params.id]);
            const [request] = await renderRequests(ctx, rows, viewer.accountId);
            if (request === undefined) throw new NotFound();

            return { status: 200, body: request };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/requests/:id/accept",
        summary: "Accept a single notification request",
        description: "Accept a notification request, which merges the filtered notifications " +
            "from that user back into the main notification and accepts any future " +
            "notification from them.",
        docs: `${docs}/#accept-request`,
        tags: ["notifications"],
        auth: write,
        params: RequestId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            const requests = await findRequests(ctx, viewer.accountId, [params.id]);
            if (requests.length === 0) throw new NotFound();
            await acceptRequests(ctx, viewer.accountId, requests);

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/requests/:id/dismiss",
        summary: "Dismiss a single notification request",
        description: "Dismiss a notification request, which hides it and prevent it from " +
            "contributing to the pending notification requests count.",
        docs: `${docs}/#dismiss-request`,
        tags: ["notifications"],
        auth: write,
        params: RequestId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            const requests = await findRequests(ctx, viewer.accountId, [params.id]);
            if (requests.length === 0) throw new NotFound();
            await dismissRequests(ctx, viewer.accountId, requests);

            return { status: 200, body: {} };
        },
    }),
];
