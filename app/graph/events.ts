/**
 * Events about the follow graph for the rest of Verso: follows requested, accepted and ended.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

const followEventTypes = [
    /** A follow is waiting for the followee to accept it. */
    "graph.follow_requested",
    /** A follow was accepted, when it was created or later. */
    "graph.follow_accepted",
    /** The followee rejected a follow, or a follow request. */
    "graph.follow_rejected",
    /** The follower unfollowed, or withdrew their follow request. */
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
