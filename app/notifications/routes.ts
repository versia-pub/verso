import { GroupedNotificationsResults, Notification } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Linked, Paged, type Route } from "../http/route.ts";
import {
    deleteNotification,
    deleteNotificationsOf,
    findNotification,
    notificationGroupPage,
    notificationPage,
} from "./notification_queries.ts";
import { renderNotificationGroups, renderNotifications, shownTo } from "./render.ts";
import { isNotificationType, type NotificationType } from "./tables.ts";

/** `types[]=a&types[]=b`, or a single `types=a`. */
const Strings = z.union([z.string().transform((one) => [one]), z.array(z.string())]);

/**
 * Types of notifications, as clients name them. Those Verso doesn't have, such as `poll`, are left
 * out, so they match no notification.
 */
const Types = (description: string) =>
    Strings.transform((types) => types.filter(isNotificationType)).optional()
        .meta({ description });

/** Mastodon's: reactions are grouped only when a client asks. */
const groupedByDefault: readonly NotificationType[] = ["favourite", "follow", "reblog"];

/**
 * The types to group, or Mastodon's by default. Types Verso doesn't group, such as `mention`, have
 * no groups anyway, and those it doesn't have, such as `poll`, are left out, so asking for only
 * `poll` groups none, as on Mastodon.
 */
const GroupedTypes = Types("Restrict which notification types can be grouped.")
    .transform((types): readonly NotificationType[] => types ?? groupedByDefault);

const docs = "https://docs.joinmastodon.org/methods/notifications";
const groupedDocs = "https://docs.joinmastodon.org/methods/grouped_notifications";

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
            types: Types("Types to include in the result."),
            exclude_types: Types("Types to exclude from the results."),
            account_id: z.string().optional().meta({
                description: "Return only notifications received from the specified account.",
            }),
        }),
        responses: { 200: Paged(Notification) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await notificationPage(
                ctx,
                viewer.accountId,
                shownTo(ctx, viewer.accountId),
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
        method: "GET",
        path: "/api/v2/notifications",
        summary: "Get all grouped notifications",
        description: "Return grouped notifications concerning the user. This API returns Link " +
            "headers containing links to the next/previous page. However, the links can also " +
            "be constructed dynamically using query params and `id` values.\n\nNotifications " +
            "from accounts the user blocks, or mutes with their notifications, and about " +
            "statuses they may no longer see, are left out, and not counted. `reaction` " +
            "notifications are grouped by status too, when `grouped_types` has `reaction`, and " +
            "a `reaction` group has its emojis.",
        docs: `${groupedDocs}/#get-grouped`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        query: PageQuery({ default: 40, max: 80 }).extend({
            types: Types("Types to include in the result."),
            exclude_types: Types("Types to exclude from the results."),
            account_id: z.string().optional().meta({
                description: "Return only notifications received from the specified account.",
            }),
            expand_accounts: z.enum(["full", "partial_avatars"]).default("full").meta({
                description: "When `partial_avatars`, the accounts of each group but its most " +
                    "recent are in `partial_accounts`, stripped down.",
            }),
            grouped_types: GroupedTypes,
        }),
        responses: { 200: Linked(GroupedNotificationsResults) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await notificationGroupPage(
                ctx,
                viewer.accountId,
                shownTo(ctx, viewer.accountId),
                { types: query.types, excludeTypes: query.exclude_types, fromId: query.account_id },
                query.grouped_types,
                query,
            );

            return {
                status: 200,
                body: await renderNotificationGroups(
                    ctx,
                    rows,
                    query.grouped_types,
                    viewer.accountId,
                    query.expand_accounts === "partial_avatars",
                ),
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
        path: "/api/v1/notifications/:id",
        summary: "Get a single notification",
        description: "View information about a notification with a given ID.",
        docs: `${docs}/#get-one`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        params: z.object({ id: z.string() }),
        responses: { 200: Notification },
        handler: async (ctx, { params, viewer }) => {
            const shown = shownTo(ctx, viewer.accountId);
            const row = await findNotification(ctx, viewer.accountId, params.id, shown);
            const [notification] = row
                ? await renderNotifications(ctx, [row], viewer.accountId)
                : [];
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
