/**
 * The `direct` stream: a user's direct conversations as they get new statuses, lose their latest,
 * or are marked read or unread.
 * @see https://docs.joinmastodon.org/methods/streaming/#direct
 * @module
 */
import { shownConversation } from "../conversations/render.ts";
import type { Context } from "../kernel/context.ts";
import { type Sessions, sessionSet } from "./dispatcher.ts";

/**
 * The `direct` streams for the sessions of the process `ctx` belongs to. A conversation is rendered
 * once, as it is when it is heard of, and sent to its owner's sessions as long as they may read
 * statuses. One that is gone by then is sent to none.
 */
export const directStreams = (ctx: Context): Sessions => {
    const { sessions, add } = sessionSet();

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
        add,
    };
};
