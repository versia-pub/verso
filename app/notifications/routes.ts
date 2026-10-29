import { Notification } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Strings } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { markersOf } from "../markers/marker_queries.ts";
import {
    countNotifications,
    deleteNotification,
    deleteNotificationsOf,
    notificationPage,
} from "./notification_queries.ts";
import { renderNotifications, shownNotification, shownOf } from "./render.ts";
import { isNotificationType } from "./tables.ts";

/**
 * Types of notifications, as clients name them. Those Verso doesn't have, such as `poll`, are left
 * out, so they match no notification.
 */
export const NotificationTypes = Strings.transform((types) => types.filter(isNotificationType))
    .optional();

/** How many unread notifications to count up to, as on Mastodon. */
export const CountQuery = PageQuery({ default: 100, max: 1000 }).pick({ limit: true });

/** Which unread notifications to count. */
export const countFilters = {
    types: NotificationTypes.meta({
        description: "Types of notifications that should count towards unread notifications.",
    }),
    exclude_types: NotificationTypes.meta({
        description: "Types of notifications that should not count towards unread notifications.",
    }),
    account_id: z.string().optional().meta({
        description: "Only count unread notifications received from the specified account.",
    }),
};

/** What `accountId` last read of their notifications, if they saved where. */
export const lastReadOf = async (
    ctx: Context,
    accountId: string,
): Promise<string | undefined> =>
    (await markersOf(ctx, accountId, ["notifications"])).at(0)?.last_read_id;

/** A count of unread notifications, or groups. */
export const Count = z.object({ count: z.int() });

export const unreadDescription =
    "A notification is considered unread if it is more recent than the " +
    "notifications read marker.\n\nBecause the count is dependent on the parameters, it is " +
    "computed every time and is thus a relatively slow operation (although faster than getting " +
    "the full corresponding notifications), therefore the number of returned notifications is " +
    "capped.";

const docs = "https://docs.joinmastodon.org/methods/notifications";

export const notificationRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications",
        summary: "Get all notifications",
        description: "Notifications concerning the user. This API returns Link headers " +
            "containing links to the next/previous page. However, the links can also be " +
            "constructed dynamically using query params and `id` values.\n\nNotifications from " +
            "accounts the user blocks, or mutes with their notifications, and about statuses " +
            "they may no longer see, are left out. A `reaction` notification has the emoji, as " +
            "Pleroma has it.",
        docs: `${docs}/#get`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        query: PageQuery({ default: 40, max: 80 }).extend({
            types: NotificationTypes.meta({ description: "Types to include in the result." }),
            exclude_types: NotificationTypes.meta({
                description: "Types to exclude from the results.",
            }),
            account_id: z.string().optional().meta({
                description: "Return only notifications received from the specified account.",
            }),
        }),
        responses: { 200: Paged(Notification) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await notificationPage(
                ctx,
                viewer.accountId,
                shownOf(ctx, viewer.accountId),
                { types: query.types, excludeTypes: query.exclude_types, fromId: query.account_id },
                query,
            );

            return {
                status: 200,
                body: await renderNotifications(ctx, rows, viewer.accountId),
                cursors: cursorsOf(rows, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/clear",
        summary: "Dismiss all notifications",
        description: "Clear all notifications from the server.",
        docs: `${docs}/#clear`,
        tags: ["notifications"],
        auth: { require: "user", scope: "write:notifications", permission: "owner:notification" },
        responses: { 200: z.object({}) },
        handler: async (ctx, { viewer }) => {
            await deleteNotificationsOf(ctx, viewer.accountId);
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications/unread_count",
        summary: "Get the number of unread notifications",
        description: "Get the (capped) number of unread notifications for the current user.\n\n" +
            unreadDescription,
        docs: `${docs}/#unread-count`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        query: CountQuery.extend(countFilters),
        responses: { 200: Count },
        handler: async (ctx, { query, viewer }) => {
            const count = await countNotifications(
                ctx,
                viewer.accountId,
                shownOf(ctx, viewer.accountId),
                { types: query.types, excludeTypes: query.exclude_types, fromId: query.account_id },
                await lastReadOf(ctx, viewer.accountId),
                query.limit,
            );

            return { status: 200, body: { count } };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/notifications/:id",
        summary: "Get a single notification",
        description: "View information about a notification with a given ID.",
        docs: `${docs}/#get-one`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        params: z.object({ id: z.string() }),
        responses: { 200: Notification },
        handler: async (ctx, { params, viewer }) => {
            const notification = await shownNotification(ctx, viewer.accountId, params.id);
            if (notification === undefined) throw new NotFound();

            return { status: 200, body: notification };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/notifications/:id/dismiss",
        summary: "Dismiss a single notification",
        description: "Dismiss a single notification from the server.",
        docs: `${docs}/#dismiss`,
        tags: ["notifications"],
        auth: { require: "user", scope: "write:notifications", permission: "owner:notification" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await deleteNotification(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
];
