/**
 * The `direct` stream: a user's direct conversations as they get new statuses, lose their latest,
 * or are marked read or unread, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#direct
 * @module
 */
import { shownConversation } from "../conversations/render.ts";
import type { Context } from "../kernel/context.ts";
import type { Sessions, StreamViewer } from "./dispatcher.ts";
import type { Session } from "./session.ts";

/** A session, with its viewer. */
type Entry = { readonly viewer: StreamViewer; readonly session: Session };

/**
 * What the sessions of the process `ctx` belongs to are sent of their viewers' `direct` streams. A
 * conversation is rendered once, as it is when it is heard of, and sent to its owner's sessions as
 * long as they may read statuses. One that is gone by then is sent to none, as on Mastodon.
 */
export const directStreams = (ctx: Context): Sessions => {
    const sessions = new Set<Entry>();

    return {
        conversations: async (message) => {
            const reached = [];
            for (const entry of sessions) {
                if (entry.viewer.accountId !== message.accountId) continue;
                if (!entry.session.subscribedTo(["direct"])) continue;
                if ((await entry.viewer.permissions()).has("read:note")) reached.push(entry);
            }
            if (reached.length === 0) return;

            const shown = await shownConversation(ctx, message.accountId, message.conversationId);
            if (shown === undefined) return;

            const payload = JSON.stringify(shown);
            for (const { session } of reached) session.deliver(["direct"], "conversation", payload);
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
