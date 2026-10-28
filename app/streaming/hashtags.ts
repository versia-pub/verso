/**
 * The `hashtag` and `hashtag:local` streams: the public statuses using a hashtag as they appear,
 * change or go, from anywhere or the local instance, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#hashtag
 * @module
 */
import type { RouteViewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { hashtagStatus } from "../notes/public.ts";
import { hashtagStream, type Session } from "./session.ts";
import { statusMessages } from "./statuses.ts";

/** Whether `stream`, as a session names it, is a hashtag's. */
const isHashtagStream = (stream: string) =>
    stream.startsWith(hashtagStream("hashtag", "")) ||
    stream.startsWith(hashtagStream("hashtag:local", ""));

/**
 * Sends `session` the events of the hashtag streams it is subscribed to, until the function
 * returned is called. A status is sent on the streams of each hashtag it uses if it could be on
 * their timelines as its viewer sees them, and they may read statuses, rendered as they see it.
 */
export const streamHashtags = (
    ctx: Context,
    viewer: RouteViewer & { readonly accountId: string },
    session: Session,
): () => void =>
    subscribe(ctx, statusMessages, async (message) => {
        const subscribed = session.streams().filter(isHashtagStream);
        if (subscribed.length === 0) return;
        if (!(await viewer.permissions()).has("read:note")) return;

        // The status is gone, so which hashtags it used isn't known, but clients ignore statuses
        // they don't have.
        if (message.event === "delete") {
            if (message.visibility === "public") {
                session.deliver(subscribed, "delete", message.noteId);
            }
            return;
        }

        const shown = await hashtagStatus(ctx, viewer.accountId, message.noteId);
        if (!shown) return;

        const names = shown.local ? ["hashtag", "hashtag:local"] : ["hashtag"];
        session.deliver(
            shown.status.tags.flatMap((tag) => names.map((name) => hashtagStream(name, tag.name))),
            message.event,
            JSON.stringify(shown.status),
        );
    });
