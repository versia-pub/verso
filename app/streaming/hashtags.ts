/**
 * The `hashtag` and `hashtag:local` streams: the public statuses using a hashtag as they appear,
 * change or go, from anywhere or the local instance.
 * @see https://docs.joinmastodon.org/methods/streaming/#hashtag
 * @module
 */
import { TimelinesAccess } from "../kernel/config_sections.ts";
import type { Context } from "../kernel/context.ts";
import { hashtagStatus } from "../notes/stream_lookups.ts";
import { hashtagStream } from "./session.ts";
import type { Sessions } from "./dispatcher.ts";
import { sharedStreams } from "./shared.ts";

/** Whether `stream`, as a session names it, is a hashtag's. */
const isHashtagStream = (stream: string) =>
    stream.startsWith(hashtagStream("hashtag", "")) ||
    stream.startsWith(hashtagStream("hashtag:local", ""));

/**
 * The hashtag streams for the sessions of the process `ctx` belongs to. A status is sent on the
 * stream of each hashtag it uses, if it could be on its timeline. It is rendered as anyone sees it
 * and sent to the sessions whose viewers may read statuses, may see statuses from where it is from
 * and don't block or mute its author.
 */
export const hashtagStreams = (
    ctx: Context,
    access: Pick<TimelinesAccess, "topic_feeds"> = TimelinesAccess.parse({}),
): Sessions =>
    sharedStreams(ctx, {
        feeds: access.topic_feeds,
        subscribed: (session) => session.streams().filter(isHashtagStream),
        find: hashtagStatus,
        streamsOf: (shown, status) => {
            const names = shown.local ? ["hashtag", "hashtag:local"] : ["hashtag"];
            return status.tags.flatMap((tag) => names.map((name) => hashtagStream(name, tag.name)));
        },
    });
