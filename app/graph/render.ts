import type { Relationship } from "@versia/client-api";
import type { FollowRow } from "./follow_queries.ts";
import type { MuteRow } from "./mute_queries.ts";

/**
 * The viewer's relationship with the account `id`, from the viewer's follow of it and its follow of
 * the viewer (either of which may be a request), whether either blocks the other, whether the
 * viewer blocks its domain, the viewer's mute of it, if they mute it, and what they note about it.
 */
export const renderRelationship = (
    id: string,
    outgoing: FollowRow | undefined,
    incoming: FollowRow | undefined,
    blocks: {
        readonly blocking: boolean;
        readonly blockedBy: boolean;
        readonly domainBlocking: boolean;
    },
    mute: MuteRow | undefined,
    note: string,
): Relationship => ({
    id,
    following: outgoing?.accepted ?? false,
    showing_reblogs: outgoing?.show_reblogs ?? false,
    notifying: outgoing?.notify ?? false,
    languages: outgoing?.languages ?? null,
    followed_by: incoming?.accepted ?? false,
    blocking: blocks.blocking,
    blocked_by: blocks.blockedBy,
    muting: mute !== undefined,
    muting_notifications: mute?.notifications ?? false,
    muting_expires_at: mute?.expires_at?.toISOString() ?? null,
    requested: outgoing !== undefined && !outgoing.accepted,
    requested_by: incoming !== undefined && !incoming.accepted,
    domain_blocking: blocks.domainBlocking,
    endorsed: false,
    note,
});
