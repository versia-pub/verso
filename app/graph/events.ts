/**
 * What the graph tells the rest of Verso: follows asked for, accepted and ended.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

const followEventTypes = [
    /** A follow waits for the followee to accept it. */
    "graph.follow_requested",
    /** A follow was accepted, as it was made or later. */
    "graph.follow_accepted",
    /** The followee rejected a follow, or a request for one. */
    "graph.follow_rejected",
    /** The follower stopped following, or withdrew asking to. */
    "graph.unfollowed",
] as const;

/** A change to the follow from `followerId` to `followeeId`. */
export type FollowEvent = {
    readonly type: (typeof followEventTypes)[number];
    readonly followerId: string;
    readonly followeeId: string;
};

const types: ReadonlySet<string> = new Set(followEventTypes);

export const isFollowEvent = (event: DomainEvent): event is FollowEvent => types.has(event.type);
