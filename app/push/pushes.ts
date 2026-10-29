/**
 * Pushing users' notifications to the browsers and apps that subscribed to them, with Web Push, as
 * Mastodon does: one job per subscription, each encrypted for it and signed as this instance.
 * @see https://docs.joinmastodon.org/methods/push/
 * @see https://www.rfc-editor.org/rfc/rfc8030
 * @module
 */
import type { Notification } from "@versia/client-api";
import { z } from "zod";
import { isFollowing } from "../graph/follows.ts";
import { enqueueAll } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import { timeoutSignal, userAgent } from "../kernel/transport.ts";
import { isNotificationCreated, type NotificationCreated } from "../notifications/events.ts";
import { shownNotification } from "../notifications/render.ts";
import { isNotificationType, type NotificationType } from "../notifications/tables.ts";
import { encryptPush, randomSender } from "./encryption.ts";
import {
    deleteSubscriptionById,
    findSubscriptionById,
    type PushSubscriptionRow,
    subscriptionsOf,
} from "./subscription_queries.ts";
import { vapidAuthorization } from "./vapid.ts";

export const pushQueue = "push";

/** The payload of a push job: what to push, and where. */
export const PushJob = z.object({ subscriptionId: z.string(), notificationId: z.string() });
export type PushJob = z.output<typeof PushJob>;

/** How long push services keep a push for a device that is offline, as on Mastodon: two days. */
const ttlSeconds = 2 * 24 * 60 * 60;

/** Tries a few times, as on Mastodon, since a push is stale soon after. */
const maxAttempts = 5;

/** Whether `subscription` asks for `created`, by its type and by whom it is from. */
const wants = async (
    ctx: Context,
    subscription: PushSubscriptionRow,
    created: NotificationCreated,
) => {
    if (!subscription.alerts.includes(created.notificationType)) return false;

    switch (subscription.policy) {
        case "all":
            return true;
        case "followed":
            return await isFollowing(ctx, created.accountId, created.fromId);
        case "follower":
            return await isFollowing(ctx, created.fromId, created.accountId);
        case "none":
            return false;
    }
};

/** Queues a push of each new notification to each of its user's subscriptions that ask for it. */
export const queuePushes = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isNotificationCreated(event)) return;

    const jobs = [];
    for (const subscription of await subscriptionsOf(ctx, event.accountId)) {
        if (!await wants(ctx, subscription, event)) continue;

        const payload: PushJob = {
            subscriptionId: subscription.id,
            notificationId: event.notificationId,
        };
        // So a push service that hangs holds only its own pushes up.
        const group = new URL(subscription.endpoint).host;
        jobs.push({ queue: pushQueue, payload, group, maxAttempts });
    }
    await enqueueAll(ctx, jobs);
};

/** Each type's title, as Mastodon's English one. */
const titles: Record<NotificationType, (name: string) => string> = {
    mention: (name) => `You were mentioned by ${name}`,
    status: (name) => `${name} just posted`,
    reblog: (name) => `${name} boosted your post`,
    follow: (name) => `${name} followed you`,
    follow_request: (name) => `${name} has requested to follow you`,
    favourite: (name) => `${name} favorited your post`,
    update: (name) => `${name} edited a post`,
    reaction: (name) => `${name} reacted to your post`,
};

/** How long a push's body may be, in characters, as on Mastodon. */
const bodyLength = 140;

/** `text` cut to at most `bodyLength` characters, as Rails' `truncate` does. */
const truncate = (text: string) => {
    const characters = Array.from(text);
    return characters.length <= bodyLength
        ? text
        : `${characters.slice(0, bodyLength - 3).join("")}...`;
};

/**
 * What a push says, as Mastodon's do, so clients can show it, or fetch the notification with the
 * token: its title and body in English, as Verso has no other languages yet.
 */
const pushOf = (
    subscription: PushSubscriptionRow,
    notification: Notification,
    type: NotificationType,
) => {
    const { account, status } = notification;
    // A content warning is text already; the rest is HTML.
    const text = status?.spoiler_text || textOfHtml(status?.content || account.note);

    return {
        access_token: subscription.access_token,
        preferred_locale: "en",
        notification_id: notification.id,
        notification_type: notification.type,
        icon: account.avatar_static,
        title: titles[type](account.display_name || account.username),
        body: truncate(text.replaceAll(/\s+/g, " ").trim()),
    };
};

/**
 * Pushes a notification to a subscription, unless either has gone, or the user isn't shown it,
 * such as one from an account they have muted since. A subscription its push service says has gone
 * is deleted, as on Mastodon. A push service that takes too long isn't tried again.
 */
export const pushHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = PushJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a push job");

    const subscription = await findSubscriptionById(ctx, payload.data.subscriptionId);
    if (!subscription) return;
    const notification = await shownNotification(
        ctx,
        subscription.account_id,
        payload.data.notificationId,
    );
    // Verso renders only its own types of notification, which are among Mastodon's.
    if (!notification || !isNotificationType(notification.type)) return;

    const push = pushOf(subscription, notification, notification.type);
    const body = await encryptPush(
        new TextEncoder().encode(JSON.stringify(push)),
        {
            p256dh: Uint8Array.fromBase64(subscription.p256dh, { alphabet: "base64url" }),
            auth: Uint8Array.fromBase64(subscription.auth, { alphabet: "base64url" }),
        },
        await randomSender(),
    );
    const request = new Request(subscription.endpoint, {
        method: "POST",
        headers: {
            authorization: await vapidAuthorization(
                await ctx.federation.vapidKey(ctx),
                subscription.endpoint,
                ctx.urls.origin,
                ctx.clock.now(),
            ),
            "user-agent": userAgent(ctx.urls.origin),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(ttlSeconds),
            urgency: "normal",
        },
        body,
        signal: timeoutSignal(ctx.settings.pushTimeoutMs, ctx.signal),
    });

    let response;
    try {
        response = await ctx.transport(request);
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new PermanentFailure(
                `The push service took over ${ctx.settings.pushTimeoutMs} ms`,
            );
        }
        throw error;
    }
    await response.body?.cancel();

    if (response.ok) return;
    if (response.status === 404 || response.status === 410) {
        return await deleteSubscriptionById(ctx, subscription.id);
    }
    if (
        response.status >= 400 && response.status <= 499 && response.status !== 408 &&
        response.status !== 429
    ) {
        throw new PermanentFailure(`The push service refused the push (${response.status})`);
    }
    throw new Error(`The push service answered ${response.status}`);
};
