import { NotificationPolicy } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { policiesOf, requestSummaryOf, savePolicy } from "./policy_queries.ts";
import { policyActions } from "./tables.ts";

/** `accountId`'s policy as Mastodon renders it, with how many requests they have. */
const renderPolicy = async (ctx: Context, accountId: string): Promise<NotificationPolicy> => {
    const policy = (await policiesOf(ctx, [accountId])).get(accountId);
    if (policy === undefined) throw new Error("Every user has a policy");
    const summary = await requestSummaryOf(ctx, accountId);

    return {
        ...policy,
        summary: {
            pending_requests_count: summary.requests,
            pending_notifications_count: summary.notifications,
        },
    };
};

/** What Mastodon says each part of a policy does, for accounts of the kind `of`. */
const actionDescription = (of: string) =>
    `Whether to \`accept\`, \`filter\` or \`drop\` notifications from ${of}. \`drop\` ` +
    "will prevent creation of the notification object altogether (without preventing the " +
    "underlying activity), `filter` will cause it to be marked as filtered, and `accept` will " +
    "not affect its processing.";

const Action = (of: string, extra = "") =>
    z.enum(policyActions).optional().meta({ description: actionDescription(of) + extra });

const docs = "https://docs.joinmastodon.org/methods/notifications";

export const notificationPolicyRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v2/notifications/policy",
        summary: "Get the filtering policy for notifications",
        description: "Notifications filtering policy for the user.",
        docs: `${docs}/#get-policy`,
        tags: ["notifications"],
        auth: { require: "user", scope: "read:notifications", permission: "owner:notification" },
        responses: { 200: NotificationPolicy },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: await renderPolicy(ctx, viewer.accountId),
        }),
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v2/notifications/policy",
        summary: "Update the filtering policy for notifications",
        description: "Update the user's notifications filtering policy.",
        docs: `${docs}/#update-the-filtering-policy-for-notifications`,
        tags: ["notifications"],
        auth: { require: "user", scope: "write:notifications", permission: "owner:notification" },
        body: z.object({
            for_not_following: Action("accounts the user is not following"),
            for_not_followers: Action("accounts that are not following the user"),
            for_new_accounts: Action("accounts created in the past 30 days"),
            for_private_mentions: Action(
                "private mentions",
                " Replies to private mentions initiated by the user, as well as accounts the " +
                    "user follows, are always allowed, regardless of this value.",
            ),
            for_limited_accounts: Action("accounts that were limited by a moderator"),
        }),
        responses: { 200: NotificationPolicy },
        handler: async (ctx, { viewer, body }) => {
            await ctx.transaction(async (tx) => {
                const policy = (await policiesOf(tx, [viewer.accountId])).get(viewer.accountId);
                if (policy === undefined) throw new Error("Every user has a policy");

                const changes = Object.fromEntries(
                    Object.entries(body).filter(([, action]) => action !== undefined),
                );
                await savePolicy(tx, viewer.accountId, { ...policy, ...changes });
            });

            return { status: 200, body: await renderPolicy(ctx, viewer.accountId) };
        },
    }),
];
