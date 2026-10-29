/**
 * Streams whose statuses are the same for every viewer who may see them, as the public and hashtag
 * streams are. Each status is looked up and rendered once for all of a process's sessions, as
 * anyone sees it, as Mastodon streams them, rather than once for each session. It is sent to the
 * sessions whose viewers may read statuses and don't hide its author.
 * @module
 */
import type { Status } from "@versia/client-api";
import { hidingAmong } from "../graph/hidden.ts";
import type { RouteViewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import type { PublicStatus } from "../notes/public.ts";
import type { Listener } from "./dispatcher.ts";
import type { Session } from "./session.ts";

/** A session's viewer, who is logged in. */
export type StreamViewer = RouteViewer & { readonly accountId: string };

/** Which statuses a kind of stream has, and on which of its streams each goes. */
export type SharedStreams = {
    /** The streams of the kind `session` is subscribed to. */
    readonly subscribed: (session: Session) => readonly string[];
    /** The status `noteId`, if the streams have it. */
    readonly find: (ctx: Context, noteId: string) => Promise<PublicStatus | undefined>;
    /** The streams `shown`, rendered as `status`, goes on. */
    readonly streamsOf: (shown: PublicStatus, status: Status) => readonly string[];
};

/** What a process's sessions are sent of a kind of stream, for those added to it. */
export type SharedSessions = Listener & {
    /** Adds `session` of `viewer`, until the function returned is called. */
    readonly add: (viewer: StreamViewer, session: Session) => () => void;
};

/** The sessions of the process `ctx` belongs to that are sent `streams`. */
export const sharedStreams = (ctx: Context, streams: SharedStreams): SharedSessions => {
    const sessions = new Set<{ readonly viewer: StreamViewer; readonly session: Session }>();

    /**
     * The sessions subscribed to any of the streams whose viewers may read statuses, with the
     * streams. Their permissions are checked one at a time, as each may need a query.
     */
    const reading = async () => {
        const subscribed = [...sessions]
            .map((each) => ({ ...each, streams: streams.subscribed(each.session) }))
            .filter((each) => each.streams.length > 0);

        const found = [];
        for (const each of subscribed) {
            if ((await each.viewer.permissions()).has("read:note")) found.push(each);
        }
        return found;
    };

    return {
        statuses: async (message) => {
            // The status is gone, so whether it was on the streams isn't known, but clients ignore
            // statuses they don't have.
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
            const payload = JSON.stringify(status);
            for (const each of readers) {
                if (!hiding.has(each.viewer.accountId)) {
                    each.session.deliver(on, message.event, payload);
                }
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
