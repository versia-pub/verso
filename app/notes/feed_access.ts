import { UserRequired } from "../http/errors.ts";
import type { RouteViewer } from "../http/route.ts";
import type { FeedAccess, TimelinesAccess } from "../kernel/config_sections.ts";
import type { Origin } from "./timeline_queries.ts";

/** Who may see the statuses of one kind of feed, by where they are from. */
export type Feeds = TimelinesAccess["live_feeds"];

/** Which statuses of a feed its viewer may see: those of this instance, others, or both. */
export type Seen = { readonly local: boolean; readonly remote: boolean };

/** Whether `viewer`, if there is one, may see what `access` allows. */
const allows = async (access: FeedAccess, viewer: RouteViewer | undefined) => {
    if (access === "public") return true;
    if (access === "authenticated") return viewer?.accountId != null;

    return (await viewer?.permissions())?.has("feeds") ?? false;
};

/** Which statuses of `feeds` `viewer` may see. */
export const seenOf = async (feeds: Feeds, viewer: RouteViewer | undefined): Promise<Seen> => ({
    local: await allows(feeds.local, viewer),
    remote: await allows(feeds.remote, viewer),
});

/**
 * Which statuses of `feeds` to return to `viewer` who asks for those from `origin`. Nobody who
 * isn't logged in may ask for a feed that isn't public, which is refused, and a viewer who may see
 * only some of what they ask for is given only that. `undefined` if they may see none of it, for
 * which the answer is an empty list.
 */
export const visibleOrigin = async (
    feeds: Feeds,
    origin: Origin,
    viewer: RouteViewer | undefined,
): Promise<Origin | undefined> => {
    const asked = origin === "all" ? [feeds.local, feeds.remote] : [feeds[origin]];
    if (asked.some((access) => access !== "public") && viewer?.accountId == null) {
        throw new UserRequired();
    }

    const { local, remote } = await seenOf(feeds, viewer);
    if (origin === "local") return local ? "local" : undefined;
    if (origin === "remote") return remote ? "remote" : undefined;

    return local && remote ? "all" : local ? "local" : remote ? "remote" : undefined;
};
