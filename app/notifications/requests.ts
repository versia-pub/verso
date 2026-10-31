/**
 * Notification requests: the mentions of a local user that their policy filtered, from one
 * account, which they accept, letting that account's notifications through from then on, or
 * dismiss. Unlike Mastodon, accepting merges the filtered notifications at once, not in a job.
 * @see https://docs.joinmastodon.org/methods/notifications/#get-requests
 * @module
 */
import { z } from "zod";
import { addToConversationsOf } from "../conversations/conversations.ts";
import type { Context } from "../kernel/context.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import {
    deleteFilteredNotifications,
    deleteRequest,
    type NotificationRequestRow,
    permitNotifications,
    unfilterNotifications,
} from "./request_queries.ts";

/** Whose accepted requests were merged into their notifications. */
export type NotificationsMergedMessage = { readonly accountId: string };

/** Says a user's accepted requests were merged, so every process can stream it to them. */
export const notificationsMerged: Channel<NotificationsMergedMessage> = {
    name: "notifications.merged",
    schema: z.object({ accountId: z.string() }),
};

/**
 * Accepts `requests`, all of `accountId`'s: their accounts' filtered notifications are shown, the
 * direct statuses among them are added to conversations, and their later notifications aren't
 * filtered or dropped.
 */
export const acceptRequests = (
    ctx: Context,
    accountId: string,
    requests: readonly NotificationRequestRow[],
): Promise<void> =>
    ctx.transaction(async (tx) => {
        for (const request of requests) {
            await permitNotifications(tx, accountId, request.from_account_id);
            const mentioned = await unfilterNotifications(tx, accountId, request.from_account_id);
            await addToConversationsOf(tx, accountId, mentioned);
            await deleteRequest(tx, request);
        }

        if (requests.length > 0) await publish(tx, notificationsMerged, { accountId });
    });

/** Dismisses `requests`, all of `accountId`'s, deleting their accounts' filtered notifications. */
export const dismissRequests = (
    ctx: Context,
    accountId: string,
    requests: readonly NotificationRequestRow[],
): Promise<void> =>
    ctx.transaction(async (tx) => {
        for (const request of requests) {
            await deleteFilteredNotifications(tx, accountId, request.from_account_id);
            await deleteRequest(tx, request);
        }
    });
