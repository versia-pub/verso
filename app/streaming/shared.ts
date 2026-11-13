/**
 * Streams whose statuses are the same for every viewer who may see them, like the public and
 * hashtag streams. Each status is looked up and rendered once for all of a process's sessions, as
 * anyone sees it, not once for each session. Only the viewer's filters that it matches are added.
 * It is sent to the sessions whose viewers may read statuses, may see statuses from where it is
 * from and don't hide its author.
 * @module
 */
import type { Status } from "@versia/client-api";
import { activeFiltersAmong, filterResults } from "../filters/matching.ts";
import { hidingAmong } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { type Feeds, type Seen, seenOf } from "../notes/feed_access.ts";
import type { PublicStatus } from "../notes/stream_lookups.ts";
import type { Sessions, StreamViewer } from "./dispatcher.ts";
import type { Session } from "./session.ts";

/** Which statuses a kind of stream has, and on which of its streams each goes. */
export type SharedStreams = {
    /** Who may see the statuses the streams have, by where they are from. */
    readonly feeds: Feeds;
    /** The streams of the kind `session` is subscribed to. */
    readonly subscribed: (session: Session) => readonly string[];
    /** The status `noteId`, if the streams have it. */
    readonly find: (ctx: Context, noteId: string) => Promise<PublicStatus | undefined>;
    /** The streams `shown`, rendered as `status`, goes on. */
    readonly streamsOf: (shown: PublicStatus, status: Status) => readonly string[];
};

/** The sessions of the process `ctx` belongs to that are sent `streams`. */
export const sharedStreams = (ctx: Context, streams: SharedStreams): Sessions => {
    const sessions = new Set<{ readonly viewer: StreamViewer; readonly session: Session }>();

    /**
     * The sessions subscribed to any of the streams whose viewers may read statuses, with their
     * streams and which of the feeds' statuses they may see. Permissions are checked one at a time,
     * because each may need a query.
     */
    const reading = async () => {
        const subscribed = [...sessions]
            .map((each) => ({ ...each, streams: streams.subscribed(each.session) }))
            .filter((each) => each.streams.length > 0);

        const found: ((typeof subscribed)[number] & { readonly seen: Seen })[] = [];
        for (const each of subscribed) {
            if ((await each.viewer.permissions()).has("read:note")) {
                found.push({ ...each, seen: await seenOf(streams.feeds, each.viewer) });
            }
        }

        return found;
    };

    return {
        statuses: async (message) => {
            // The status is gone, so there's no telling whether it was on the streams, but clients
            // ignore deletes of statuses they don't have.
            if (message.event === "delete") {
                if (message.visibility !== "public") return;

                for (const each of await reading()) {
                    each.session.deliver(each.streams, "delete", message.noteId);
                }

                return;
            }

            const readers = await reading();
            if (readers.length === 0) return;

            const shown = await streams.find(ctx, message.noteId);
            if (!shown) return;

            const viewerIds = new Set(readers.map((each) => each.viewer.accountId));
            const hiding = await hidingAmong(ctx, shown.accountId, [...viewerIds]);
            const status = await shown.render();
            const on = streams.streamsOf(shown, status);
            const filters = await activeFiltersAmong(ctx, [...viewerIds]);
            const unfiltered = JSON.stringify({ ...status, filtered: [] });

            for (const { viewer, session, seen } of readers) {
                if (hiding.has(viewer.accountId)) continue;
                // Mastodon also drops statuses from an origin that is disabled to the viewer.
                if (!(shown.local ? seen.local : seen.remote)) continue;

                const filtered = filterResults(filters.get(viewer.accountId) ?? [], status);
                const payload = filtered.length === 0
                    ? unfiltered
                    : JSON.stringify({ ...status, filtered });
                session.deliver(on, message.event, payload);
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
