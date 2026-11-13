/**
 * The `public` streams: the statuses of the public timeline as they appear, change or go, from
 * anywhere, the local instance or remote instances, and of those, the ones with media attached.
 * @see https://docs.joinmastodon.org/methods/streaming/#public
 * @module
 */
import { TimelinesAccess } from "../kernel/config_sections.ts";
import type { Context } from "../kernel/context.ts";
import { publicStatus } from "../notes/stream_lookups.ts";
import type { Sessions } from "./dispatcher.ts";
import { sharedStreams } from "./shared.ts";

const streams = [
    "public",
    "public:media",
    "public:local",
    "public:local:media",
    "public:remote",
    "public:remote:media",
];

/**
 * The `public` streams for the sessions of the process `ctx` belongs to. A status is sent if it is
 * on the public timeline. It is rendered as anyone sees it and sent to the sessions whose viewers
 * may read statuses, may see statuses from where it is from and don't block or mute its author,
 * as on the public timeline.
 */
export const publicStreams = (
    ctx: Context,
    access: Pick<TimelinesAccess, "live_feeds"> = TimelinesAccess.parse({}),
): Sessions =>
    sharedStreams(ctx, {
        feeds: access.live_feeds,
        subscribed: (session) => session.streams().filter((stream) => streams.includes(stream)),
        find: publicStatus,
        streamsOf: (shown, status) => {
            const origin = shown.local ? "public:local" : "public:remote";
            return status.media_attachments.length > 0
                ? ["public", origin, "public:media", `${origin}:media`]
                : ["public", origin];
        },
    });
