/**
 * The `public` streams: the statuses of the public timeline as they appear, change or go, from
 * anywhere, the local instance or remote instances, and of those, the ones with media attached, as
 * on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#public
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { publicStatus } from "../notes/public.ts";
import { type SharedSessions, sharedStreams } from "./shared.ts";

const streams = [
    "public",
    "public:media",
    "public:local",
    "public:local:media",
    "public:remote",
    "public:remote:media",
];

/**
 * What the sessions of the process `ctx` belongs to are sent of the `public` streams. A status is
 * sent if it is on the public timeline, rendered as anyone sees it, to those whose viewers may read
 * statuses and don't block or mute its author, as on the public timeline.
 */
export const publicStreams = (ctx: Context): SharedSessions =>
    sharedStreams(ctx, {
        subscribed: (session) => session.streams().filter((stream) => streams.includes(stream)),
        find: publicStatus,
        streamsOf: (shown, status) => {
            const origin = shown.local ? "public:local" : "public:remote";
            return status.media_attachments.length > 0
                ? ["public", origin, "public:media", `${origin}:media`]
                : ["public", origin];
        },
    });
