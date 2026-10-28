/**
 * The `user` and `user:notification` streams: the statuses of a user's home timeline as they
 * appear, change or go, and their notifications, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#user
 * @module
 */
import { isFollowing } from "../graph/follows.ts";
import type { Viewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { grants } from "../kernel/scopes.ts";
import { homeStatus } from "../notes/home.ts";
import { notified } from "../notifications/notifications.ts";
import { shownNotification } from "../notifications/render.ts";
import type { Session } from "./session.ts";
import { type StatusMessage, statusMessages } from "./statuses.ts";

/** Whether `viewerId` could see the status deleted, so is told it went. */
const couldSee = async (
    ctx: Context,
    viewerId: string,
    deleted: Extract<StatusMessage, { event: "delete" }>,
) => deleted.accountId === viewerId || deleted.mentionIds.includes(viewerId) ||
    (deleted.visibility !== "direct" && await isFollowing(ctx, viewerId, deleted.accountId));

/**
 * Sends `session` the events of its viewer's `user` streams while it is subscribed to them, until
 * the function returned is called. A status is sent if it is on their home timeline when it is
 * heard of, and a notification if they are shown it, each rendered as they see it. As on Mastodon,
 * the `user` stream has notifications only if the token may read them.
 */
export const streamUser = (
    ctx: Context,
    viewer: Viewer & { readonly accountId: string },
    session: Session,
): () => void => {
    const viewerId = viewer.accountId;

    const unsubscribeStatuses = subscribe(ctx, statusMessages, async (message) => {
        if (!session.subscribedTo(["user"])) return;

        if (message.event === "delete") {
            if (await couldSee(ctx, viewerId, message)) {
                session.deliver(["user"], "delete", message.noteId);
            }
            return;
        }

        const status = await homeStatus(ctx, viewerId, message.noteId);
        if (status) session.deliver(["user"], message.event, JSON.stringify(status));
    });

    const streams = grants(viewer.scopes, "read:notifications")
        ? ["user", "user:notification"]
        : ["user:notification"];
    const unsubscribeNotifications = subscribe(ctx, notified, async (message) => {
        if (message.accountId !== viewerId || !session.subscribedTo(streams)) return;

        const notification = await shownNotification(ctx, viewerId, message.notificationId);
        if (notification) session.deliver(streams, "notification", JSON.stringify(notification));
    });

    return () => {
        unsubscribeStatuses();
        unsubscribeNotifications();
    };
};
