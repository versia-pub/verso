/**
 * The `user` and `user:notification` streams: the statuses of a user's home timeline as they
 * appear, change or go, their notifications, when the notification requests they accepted are
 * merged, and on `user`, when their filters change, and the announcements published, changed or
 * taken down, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#user
 * @module
 */
import { findPublishedAnnouncement } from "../announcements/announcement_queries.ts";
import { reactionsOf } from "../announcements/reaction_queries.ts";
import { renderAnnouncements, renderReaction } from "../announcements/render.ts";
import { followersAmong } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { grants } from "../kernel/scopes.ts";
import { homeReachOf, homeStatus } from "../notes/stream_lookups.ts";
import { shownNotification } from "../notifications/render.ts";
import { followingAnyTagAmong, tagFollowersAmong } from "../tags/tag_follow_queries.ts";
import { atMost, type Sessions, type StreamViewer } from "./dispatcher.ts";
import type { Session } from "./session.ts";
import type { StatusMessage } from "./statuses.ts";

/** A session, with its viewer. */
type Entry = { readonly viewer: StreamViewer; readonly session: Session };

/** How many viewers a status is rendered for at once, each with queries of its own. */
const viewersAtOnce = 8;

/**
 * The streams a session is sent its viewer's notifications on. As on Mastodon, the `user` stream
 * has them only if the token may read them.
 */
const notificationStreams = (viewer: StreamViewer) =>
    grants(viewer.scopes, "read:notifications")
        ? ["user", "user:notification"]
        : ["user:notification"];

/** Of `entries`, those whose viewers may `permission`, checked one at a time, as each may query. */
const allowed = async (entries: readonly Entry[], permission: Permission) => {
    const found = [];
    for (const entry of entries) {
        if ((await entry.viewer.permissions()).has(permission)) found.push(entry);
    }
    return found;
};

/**
 * Of `entries`, those whose viewers could have the status `deleted` on their home timelines, so
 * are told it went: its author, those it mentions, and unless it was direct, its author's
 * followers. A public status could also be there through the hashtags they follow, which are gone
 * with it, so all who follow any hashtag are told too, as clients ignore statuses they don't have.
 */
const couldSee = async (
    ctx: Context,
    entries: readonly Entry[],
    deleted: Extract<StatusMessage, { event: "delete" }>,
) => {
    const viewerIds = new Set(entries.map((entry) => entry.viewer.accountId));
    const followers = deleted.visibility === "direct"
        ? new Set()
        : await followersAmong(ctx, deleted.accountId, [...viewerIds]);
    const tagFollowers = deleted.visibility === "public"
        ? await followingAnyTagAmong(ctx, [...viewerIds])
        : new Set();

    return entries.filter(({ viewer }) =>
        viewer.accountId === deleted.accountId || deleted.mentionIds.includes(viewer.accountId) ||
        followers.has(viewer.accountId) || tagFollowers.has(viewer.accountId)
    );
};

/**
 * What the sessions of the process `ctx` belongs to are sent of their viewers' `user` streams. A
 * status is looked up for the viewers it could reach, its author, their followers and those who
 * follow its hashtags, and sent if it is on their home timeline when it is heard of, rendered once
 * for each of them, as they see it. A notification is rendered once for its viewer. Each is sent as
 * long as they may read statuses and their notifications, as on the routes for them. An announcement
 * is rendered once, as anyone sees it, for every session.
 */
export const userStreams = (ctx: Context): Sessions => {
    const sessions = new Set<Entry>();

    /** Sends each of `entries` what `render` renders for its viewer, rendering it once for each. */
    const deliverEach = async (
        entries: readonly Entry[],
        render: (viewerId: string) => Promise<unknown>,
        send: (entry: Entry, payload: string) => void,
    ) => {
        const byViewer = Map.groupBy(entries, (entry) => entry.viewer.accountId);
        await atMost(viewersAtOnce, [...byViewer], async ([viewerId, reached]) => {
            const shown = await render(viewerId);
            if (shown === undefined) return;

            const payload = JSON.stringify(shown);
            for (const entry of reached) send(entry, payload);
        });
    };

    return {
        statuses: async (message) => {
            const subscribed = [...sessions].filter((entry) =>
                entry.session.subscribedTo(["user"])
            );
            if (subscribed.length === 0) return;

            if (message.event === "delete") {
                const told = await allowed(await couldSee(ctx, subscribed, message), "read:note");
                for (const { session } of told) session.deliver(["user"], "delete", message.noteId);
                return;
            }

            const reach = await homeReachOf(ctx, message.noteId);
            if (reach === undefined) return;
            const { authorId, tags } = reach;
            const viewerIds = new Set(subscribed.map((entry) => entry.viewer.accountId));
            const followers = await followersAmong(ctx, authorId, [...viewerIds]);
            const tagFollowers = await tagFollowersAmong(ctx, tags, [...viewerIds]);
            const reached = await allowed(
                subscribed.filter(({ viewer }) =>
                    viewer.accountId === authorId || followers.has(viewer.accountId) ||
                    tagFollowers.has(viewer.accountId)
                ),
                "read:note",
            );

            await deliverEach(
                reached,
                (viewerId) => homeStatus(ctx, viewerId, message.noteId),
                ({ session }, payload) => session.deliver(["user"], message.event, payload),
            );
        },
        notifications: async (message) => {
            const subscribed = [...sessions].filter(({ viewer, session }) =>
                viewer.accountId === message.accountId &&
                session.subscribedTo(notificationStreams(viewer))
            );
            const reached = await allowed(subscribed, "owner:notification");

            await deliverEach(
                reached,
                (viewerId) => shownNotification(ctx, viewerId, message.notificationId),
                ({ viewer, session }, payload) =>
                    session.deliver(notificationStreams(viewer), "notification", payload),
            );
        },
        notificationsMerged: async (message) => {
            const subscribed = [...sessions].filter(({ viewer, session }) =>
                viewer.accountId === message.accountId &&
                session.subscribedTo(notificationStreams(viewer))
            );

            for (const { viewer, session } of await allowed(subscribed, "owner:notification")) {
                session.deliver(notificationStreams(viewer), "notifications_merged", "1");
            }
        },
        filtersChanged: (message) => {
            for (const { viewer, session } of sessions) {
                if (viewer.accountId === message.accountId) {
                    session.deliver(["user"], "filters_changed");
                }
            }
            return Promise.resolve();
        },
        announcements: async (message) => {
            const subscribed = [...sessions].filter((entry) =>
                entry.session.subscribedTo(["user"])
            );
            if (subscribed.length === 0) return;

            if (!message.published) {
                for (const { session } of subscribed) {
                    session.deliver(["user"], "announcement.delete", message.id);
                }
                return;
            }

            // Rendered once, as anyone sees it, as on Mastodon.
            const row = await findPublishedAnnouncement(ctx, message.id);
            if (row === undefined) return;
            const [shown] = await renderAnnouncements(ctx, [row], null);
            const payload = JSON.stringify(shown);
            for (const { session } of subscribed) {
                session.deliver(["user"], "announcement", payload);
            }
        },
        announcementReactions: async (message) => {
            const subscribed = [...sessions].filter((entry) =>
                entry.session.subscribedTo(["user"])
            );
            if (subscribed.length === 0) return;
            if (await findPublishedAnnouncement(ctx, message.announcementId) === undefined) return;

            // As on Mastodon: with none of them left if the last was undone, and not for a viewer.
            const emoji = message.emojiId === null
                ? { text: message.name, emoji_id: null }
                : { text: null, emoji_id: message.emojiId };
            const [group] = (await reactionsOf(ctx, [message.announcementId], null, emoji))
                .get(message.announcementId) ?? [];
            const reaction = group
                ? renderReaction(ctx, group, false)
                : { name: message.name, count: 0 };
            const payload = JSON.stringify({
                ...reaction,
                announcement_id: message.announcementId,
            });
            for (const { session } of subscribed) {
                session.deliver(["user"], "announcement.reaction", payload);
            }
        },
        add: (viewer, session) => {
            const entry = { viewer, session };
            sessions.add(entry);
            return () => {
                sessions.delete(entry);
            };
        },
    };
};
