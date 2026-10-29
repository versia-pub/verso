/**
 * The `hashtag` and `hashtag:local` streams: the public statuses using a hashtag as they appear,
 * change or go, from anywhere or the local instance, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#hashtag
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { hashtagStatus } from "../notes/public.ts";
import { hashtagStream } from "./session.ts";
import { type SharedSessions, sharedStreams } from "./shared.ts";

/** Whether `stream`, as a session names it, is a hashtag's. */
const isHashtagStream = (stream: string) =>
    stream.startsWith(hashtagStream("hashtag", "")) ||
    stream.startsWith(hashtagStream("hashtag:local", ""));

/**
 * What the sessions of the process `ctx` belongs to are sent of the hashtag streams. A status is
 * sent on the streams of each hashtag it uses if it could be on their timelines, rendered as anyone
 * sees it, to those whose viewers may read statuses and don't block or mute its author.
 */
export const hashtagStreams = (ctx: Context): SharedSessions =>
    sharedStreams(ctx, {
        subscribed: (session) => session.streams().filter(isHashtagStream),
        find: hashtagStatus,
        streamsOf: (shown, status) => {
            const names = shown.local ? ["hashtag", "hashtag:local"] : ["hashtag"];
            return status.tags.flatMap((tag) => names.map((name) => hashtagStream(name, tag.name)));
        },
    });
