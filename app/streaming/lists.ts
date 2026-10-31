/**
 * The `list` stream: the statuses of one of a user's lists as they appear, change or go, as on
 * Mastodon. Sessions only subscribe to their viewers' own lists.
 * @see https://docs.joinmastodon.org/methods/streaming/#list
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { listsWithAmong } from "../lists/list_queries.ts";
import { listReachOf, listStatus } from "../notes/stream_lookups.ts";
import type { Sessions, StreamViewer } from "./dispatcher.ts";
import { listStream, type Session } from "./session.ts";

/** A session, with its viewer. */
type Entry = { readonly viewer: StreamViewer; readonly session: Session };

/** The lists whose streams `session` is subscribed to, by their ids. */
const listIdsOf = (session: Session) =>
    session.streams()
        .filter((stream) => stream.startsWith(listStream("")))
        .map((stream) => stream.slice(listStream("").length));

/**
 * What the sessions of the process `ctx` belongs to are sent of their viewers' `list` streams. A
 * status goes on the streams of the subscribed lists its author is in, if it is on the list when it
 * is heard of, rendered once for each list, as its owner sees it, and sent as long as they may read
 * statuses. A deleted status's id goes on them all, unless it was direct, as clients ignore
 * statuses they don't have.
 */
export const listStreams = (ctx: Context): Sessions => {
    const sessions = new Set<Entry>();

    /** The sessions subscribed to any list's stream whose viewers may read statuses. */
    const reading = async () => {
        const found = [];
        for (const entry of sessions) {
            if (listIdsOf(entry.session).length === 0) continue;
            if ((await entry.viewer.permissions()).has("read:note")) found.push(entry);
        }
        return found;
    };

    return {
        statuses: async (message) => {
            if (message.event === "delete" && message.visibility === "direct") return;

            const readers = await reading();
            if (readers.length === 0) return;

            const authorId = message.event === "delete"
                ? message.accountId
                : await listReachOf(ctx, message.noteId);
            if (authorId === undefined) return;

            const listIds = [...new Set(readers.flatMap(({ session }) => listIdsOf(session)))];
            for (const list of await listsWithAmong(ctx, listIds, authorId)) {
                const owners = readers.filter(({ viewer, session }) =>
                    viewer.accountId === list.account_id && listIdsOf(session).includes(list.id)
                );
                if (owners.length === 0) continue;

                const streams = [listStream(list.id)];
                if (message.event === "delete") {
                    for (const { session } of owners) {
                        session.deliver(streams, "delete", message.noteId);
                    }
                    continue;
                }

                const shown = await listStatus(ctx, list, message.noteId);
                if (shown === undefined) continue;

                const payload = JSON.stringify(shown);
                for (const { session } of owners) session.deliver(streams, message.event, payload);
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
