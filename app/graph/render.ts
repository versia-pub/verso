import type { Relationship } from "@versia/client-api";
import type { FollowRow } from "./follow_queries.ts";

/**
 * The viewer's relationship with the account `id`, from the viewer's follow of it and its follow
 * of the viewer, either of which may be a request. Blocks and mutes are none yet.
 */
export const renderRelationship = (
    id: string,
    outgoing: FollowRow | undefined,
    incoming: FollowRow | undefined,
): Relationship => ({
    id,
    following: outgoing?.accepted ?? false,
    showing_reblogs: outgoing?.show_reblogs ?? false,
    notifying: outgoing?.notify ?? false,
    languages: outgoing?.languages ?? null,
    followed_by: incoming?.accepted ?? false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    muting_expires_at: null,
    requested: outgoing !== undefined && !outgoing.accepted,
    requested_by: incoming !== undefined && !incoming.accepted,
    domain_blocking: false,
    endorsed: false,
    note: "",
});
