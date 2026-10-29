/**
 * The `public` streams: the statuses of the public timeline as they appear, change or go, from
 * anywhere, the local instance or remote instances, and of those, the ones with media attached, as
 * on Mastodon.
 * @see https://docs.joinmastodon.org/methods/streaming/#public
 * @module
 */
import type { RouteViewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { publicStatus } from "../notes/public.ts";
import type { Session } from "./session.ts";
import type { Listener } from "./dispatcher.ts";

const streams = [
    "public",
    "public:media",
    "public:local",
    "public:local:media",
    "public:remote",
    "public:remote:media",
];

/**
 * What `session` is sent of the `public` streams while it is subscribed to any of them. A status
 * is sent if it is on the public timeline its viewer sees, and they may read statuses, as on the
 * public timeline, rendered as they see it.
 */
export const streamPublic = (
    ctx: Context,
    viewer: RouteViewer & { readonly accountId: string },
    session: Session,
): Listener => ({
    statuses: async (message) => {
        if (!session.subscribedTo(streams)) return;
        if (!(await viewer.permissions()).has("read:note")) return;

        // The status is gone, so where it was from isn't known, but clients ignore statuses they
        // don't have.
        if (message.event === "delete") {
            if (message.visibility === "public") {
                session.deliver(streams, "delete", message.noteId);
            }
            return;
        }

        const shown = await publicStatus(ctx, viewer.accountId, message.noteId);
        if (!shown) return;

        const origin = shown.local ? "public:local" : "public:remote";
        const media = shown.status.media_attachments.length > 0;
        session.deliver(
            media ? ["public", origin, "public:media", `${origin}:media`] : ["public", origin],
            message.event,
            JSON.stringify(shown.status),
        );
    },
});
