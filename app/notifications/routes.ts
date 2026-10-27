import { Account, GroupedNotificationsResults, Notification } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Linked, Paged, type Route } from "../http/route.ts";
import { Strings } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { markersOf } from "../markers/marker_queries.ts";
import {
    countNotifications,
    deleteGroup,
    deleteNotification,
    deleteNotificationsOf,
    findGroupNotification,
    findNotification,
    groupAccountPage,
    notificationGroupPage,
    notificationPage,
} from "./notification_queries.ts";
import { renderNotificationGroups, renderNotifications, shownTo } from "./render.ts";
import { isNotificationType, type NotificationType } from "./tables.ts";

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

/** How many unread notifications to count up to, as on Mastodon. */
const CountQuery = PageQuery({ default: 100, max: 1000 }).pick({ limit: true });

/** Which unread notifications to count. */
const countFilters = {
    types: Types("Types of notifications that should count towards unread notifications."),
    exclude_types: Types(
        "Types of notifications that should not count towards unread notifications.",
    ),
    account_id: z.string().optional().meta({
        description: "Only count unread notifications received from the specified account.",
    }),
};

/** What `accountId` last read of their notifications, if they saved where. */
const lastReadOf = async (ctx: Context, accountId: string) =>
    (await markersOf(ctx, accountId, ["notifications"])).at(0)?.last_read_id;

/** A count of unread notifications, or groups. */
const Count = z.object({ count: z.int() });

const unreadDescription = "A notification is considered unread if it is more recent than the " +
    "notifications read marker.\n\nBecause the count is dependent on the parameters, it is " +
    "computed every time and is thus a relatively slow operation (although faster than getting " +
    "the full corresponding notifications), therefore the number of returned notifications is " +
    "capped.";

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
                shownTo(ctx, viewer.accountId),
                { types: query.types, excludeTypes: query.exclude_types, fromId: query.account_id },
                query.grouped_types,
                { min_id: await lastReadOf(ctx, viewer.accountId), limit: query.limit },
            );

            return { status: 200, body: { count: groups.length } };
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
            const shown = shownTo(ctx, viewer.accountId);
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
            const shown = shownTo(ctx, viewer.accountId);
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
        description:
            `Get the (capped) number of unread notifications for the current user.\n\n${unreadDescription}`,
        docs: `${docs}/#unread-count`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        query: CountQuery.extend(countFilters),
        responses: { 200: Count },
        handler: async (ctx, { query, viewer }) => {
            const count = await countNotifications(
                ctx,
                viewer.accountId,
                shownTo(ctx, viewer.accountId),
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
