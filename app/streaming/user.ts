/**
 * The `user` and `user:notification` streams: the statuses of a user's home timeline as they
 * appear, change or go, their notifications, and when notification requests they accepted are
 * merged. `user` also says when their filters change, and when announcements are published,
 * changed or taken down.
 * @see https://docs.joinmastodon.org/methods/streaming/#user
 * @module
 */
import { findPublishedAnnouncement } from "../announcements/announcement_queries.ts";
import { reactionsOf } from "../announcements/reaction_queries.ts";
import { renderAnnouncements, renderReaction } from "../announcements/render.ts";
import { batchesOf } from "../db/batches.ts";
import { followersAmong } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { grants } from "../kernel/scopes.ts";
import { homeNote, homeReachOf, statusesFor } from "../notes/stream_lookups.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { shownNotification } from "../notifications/render.ts";
import { followingAnyTagAmong, tagFollowersAmong } from "../tags/tag_follow_queries.ts";
import { atMost, type Sessions, type StreamViewer } from "./dispatcher.ts";
import type { Session } from "./session.ts";
import type { StatusMessage } from "./statuses.ts";

/** A session, with its viewer. */
type Entry = { readonly viewer: StreamViewer; readonly session: Session };

/**
 * How many viewers are handled at once when looking up a status on their home timelines or
 * rendering a notification for them. Each needs queries of its own.
 */
const viewersAtOnce = 8;

/** How many viewers a status is rendered for together, so that its queries list them all. */
const renderedTogether = 500;

/**
 * The streams a session is sent its viewer's notifications on. The `user` stream has them only if
 * the token may read them.
 */
const notificationStreams = (viewer: StreamViewer) =>
    grants(viewer.scopes, "read:notifications")
        ? ["user", "user:notification"]
        : ["user:notification"];

/**
 * Of `entries`, those whose viewers may `permission`. A viewer's permissions are looked up once,
 * for all its sessions, and kept until its roles change, so most are known already.
 */
const allowed = async (entries: readonly Entry[], permission: Permission) => {
    const granted = await Promise.all(entries.map((entry) => entry.viewer.permissions()));
    return entries.filter((_, index) => granted[index].has(permission));
};

/**
 * Of `entries`, those whose viewers could have the status `deleted` on their home timelines, so
 * are told it went. They are its author, those it mentions and, unless it was direct, its author's
 * followers. A public status could also be there through the hashtags they follow. Those are gone
 * with it, so everyone who follows any hashtag is told too, because clients ignore statuses they
 * don't have.
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
 * The `user` streams for the sessions of the process `ctx` belongs to. A status is looked up for
 * the viewers it could reach: its author, their followers and those who follow its hashtags. It is
 * sent if it is on their home timeline when it is heard of, rendered for all of them together, as
 * each sees it. A notification is rendered once for its viewer. Statuses are sent as long as the
 * viewer may read statuses, and notifications as long as they may read their notifications, as on
 * the routes for them. An announcement is rendered once, as anyone sees it, for every session.
 */
export const userStreams = (ctx: Context): Sessions => {
    const sessions = new Set<Entry>();

    /** Sends each of `entries` what `render` renders for its viewer, once for each viewer. */
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

            const byViewer = Map.groupBy(reached, (entry) => entry.viewer.accountId);
            const home: [string, NoteRow][] = [];
            await atMost(viewersAtOnce, [...byViewer.keys()], async (viewerId) => {
                const note = await homeNote(ctx, viewerId, message.noteId);
                if (note) home.push([viewerId, note]);
            });

            const note = home[0]?.[1];
            if (note === undefined) return;

            await atMost(1, batchesOf(home, renderedTogether), async (batch) => {
                const shown = await statusesFor(ctx, note, batch.map(([viewerId]) => viewerId));
                for (const [viewerId, status] of shown) {
                    const payload = JSON.stringify(status);
                    for (const { session } of byViewer.get(viewerId) ?? []) {
                        session.deliver(["user"], message.event, payload);
                    }
                }
            });
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

            // Rendered once, as anyone sees it.
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

            // The count is 0 if the last reaction was undone, and no viewer is given. Mastodon's
            // announcement reaction events do the same.
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
