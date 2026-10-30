/**
 * Mastodon's grouped notifications: notifications of the same type about the same status, or
 * follows, shown together.
 * @see https://docs.joinmastodon.org/methods/grouped_notifications/
 * @module
 */
import { Account, GroupedNotificationsResults } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Linked, Paged } from "../http/responses.ts";
import { deleteNotificationsOf } from "./notification_queries.ts";
import {
    deleteGroup,
    findGroupNotification,
    groupAccountPage,
    notificationGroupPage,
} from "./group_queries.ts";
import { renderNotificationGroups, shownOf } from "./render.ts";
import {
    Count,
    countFilters,
    CountQuery,
    lastReadOf,
    NotificationTypes,
    unreadDescription,
} from "./routes.ts";
import type { NotificationType } from "./tables.ts";

/** Mastodon's: reactions are grouped only when a client asks. */
const groupedByDefault: readonly NotificationType[] = ["favourite", "follow", "reblog"];

/**
 * The types to group, or Mastodon's by default. Types Verso doesn't group, such as `mention`, have
 * no groups anyway, and those it doesn't have, such as `poll`, are left out, so asking for only
 * `poll` groups none, as on Mastodon.
 */
const GroupedTypes = NotificationTypes.meta({
    description: "Restrict which notification types can be grouped.",
})
    .transform((types): readonly NotificationType[] => types ?? groupedByDefault);

const groupedDocs = "https://docs.joinmastodon.org/methods/grouped_notifications";

export const groupedNotificationRoutes: readonly Route[] = [
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
            types: NotificationTypes.meta({ description: "Types to include in the result." }),
            exclude_types: NotificationTypes.meta({
                description: "Types to exclude from the results.",
            }),
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
                shownOf(ctx, viewer.accountId),
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
                    { partial: query.expand_accounts === "partial_avatars", paged: true },
                ),
                cursors: cursorsOf(rows, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/notifications/unread_count",
        summary: "Get the number of unread notifications",
        description: "Get the (capped) number of unread notification groups for the current " +
            `user.\n\n${unreadDescription}`,
        docs: `${groupedDocs}/#unread-group-count`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        query: CountQuery.extend({ ...countFilters, grouped_types: GroupedTypes }),
        responses: { 200: Count },
        handler: async (ctx, { query, viewer }) => {
            const groups = await notificationGroupPage(
                ctx,
                viewer.accountId,
                shownOf(ctx, viewer.accountId),
                { types: query.types, excludeTypes: query.exclude_types, fromId: query.account_id },
                query.grouped_types,
                { min_id: await lastReadOf(ctx, viewer.accountId), limit: query.limit },
            );

            return { status: 200, body: { count: groups.length } };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v2/notifications/clear",
        summary: "Dismiss all notifications",
        description: "Clear all notifications from the server.",
        docs: "https://docs.joinmastodon.org/methods/notifications/#clear",
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
        path: "/api/v2/notifications/:group_key",
        summary: "Get a single notification group",
        description: "View information about a specific notification group with a given group " +
            "key.\n\nIt is counted and sampled as a whole, leaving out notifications from " +
            "accounts the user blocks, or mutes with their notifications.",
        docs: `${groupedDocs}/#get-notification-group`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        params: z.object({ group_key: z.string() }),
        responses: { 200: GroupedNotificationsResults },
        handler: async (ctx, { params, viewer }) => {
            const key = params.group_key;
            const shown = shownOf(ctx, viewer.accountId);
            const row = await findGroupNotification(ctx, viewer.accountId, key, shown);
            if (row === undefined) throw new NotFound();

            // Grouped whatever its type, unless the key names it on its own.
            const grouped = row.group_key === key ? [row.type] : [];
            return {
                status: 200,
                body: await renderNotificationGroups(ctx, [row], grouped, viewer.accountId, {
                    partial: false,
                    paged: false,
                }),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/notifications/:group_key/accounts",
        summary: "Get accounts of all notifications in a notification group",
        description: "The accounts that caused the notifications of a group, newest first, " +
            "each once.",
        docs: `${groupedDocs}/#get-group-accounts`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        params: z.object({ group_key: z.string() }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            const shown = shownOf(ctx, viewer.accountId);
            const rows = await groupAccountPage(
                ctx,
                viewer.accountId,
                params.group_key,
                shown,
                query,
            );

            return {
                status: 200,
                body: await publicAccounts(ctx, rows.map((row) => row.from_account_id)),
                cursors: cursorsOf(rows, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v2/notifications/:group_key/dismiss",
        summary: "Dismiss a single notification group",
        description: "Dismiss a single notification group from the server.",
        docs: `${groupedDocs}/#dismiss-group`,
        tags: ["notifications"],
        auth: { require: "user", scope: "write:notifications", permission: "owner:notification" },
        params: z.object({ group_key: z.string() }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            await deleteGroup(ctx, viewer.accountId, params.group_key);
            return { status: 200, body: {} };
        },
    }),
];
