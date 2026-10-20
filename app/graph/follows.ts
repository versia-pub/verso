/**
 * Following accounts, on this instance or another.
 * @module
 */
import { countFollow, findAccount } from "../accounts/accounts.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { FollowEvent } from "./events.ts";
import {
    acceptPendingFollow,
    deleteFollow,
    type FollowOptions,
    followsFrom,
    insertFollow,
    updateFollowOptions,
} from "./follow_queries.ts";

/** What became of asking to follow an account. */
export type FollowResult =
    /** There is no such account, or it is the follower's own. */
    | "missing"
    /** Its instance is blocked. */
    | "blocked"
    /** Following it, now or already. */
    | "following"
    /** Waiting for it to accept, now or already. */
    | "requested";

const emitFollow = (
    ctx: Context,
    type: FollowEvent["type"],
    followerId: string,
    followeeId: string,
) => {
    const event: FollowEvent = { type, followerId, followeeId };
    return emit(ctx, event);
};

/**
 * Has `followerId` follow `followeeId`, or ask to, if the followee is locked or on another instance,
 * which accepts for it. Following again only changes the options given.
 */
export const follow = (
    ctx: Context,
    followerId: string,
    followeeId: string,
    options: FollowOptions = {},
): Promise<FollowResult> =>
    ctx.transaction(async (tx) => {
        const followee = await findAccount(tx, followeeId);
        if (followee === undefined || followeeId === followerId) return "missing";
        if (followee.domain !== null && await tx.federation.isBlocked(tx, followee.domain)) {
            return "blocked";
        }

        const accepted = followee.domain === null && !followee.locked;
        const added = await insertFollow(tx, { followerId, followeeId, accepted, options });

        if (added) {
            if (accepted) await countFollow(tx, followerId, followeeId, 1);
            const type = accepted ? "graph.follow_accepted" : "graph.follow_requested";
            await emitFollow(tx, type, followerId, followeeId);

            return accepted ? "following" : "requested";
        }

        await updateFollowOptions(tx, followerId, followeeId, options);
        const [existing] = await followsFrom(tx, followerId, [followeeId]);

        return existing?.accepted ? "following" : "requested";
    });

/**
 * Has `followeeId` accept the follow `followerId` asked for. Returns whether there was one waiting.
 */
export const acceptFollow = (
    ctx: Context,
    followerId: string,
    followeeId: string,
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (!await acceptPendingFollow(tx, followerId, followeeId)) return false;

        await countFollow(tx, followerId, followeeId, 1);
        await emitFollow(tx, "graph.follow_accepted", followerId, followeeId);

        return true;
    });

/** Removes a follow, or a request for one, and says why. */
const endFollow = (
    ctx: Context,
    type: "graph.follow_rejected" | "graph.unfollowed",
    followerId: string,
    followeeId: string,
) => ctx.transaction(async (tx) => {
    const removed = await deleteFollow(tx, followerId, followeeId);
    if (removed === undefined) return false;

    if (removed.accepted) await countFollow(tx, followerId, followeeId, -1);
    await emitFollow(tx, type, followerId, followeeId);

    return true;
});

/**
 * Has `followeeId` reject `followerId`: their request to follow, or their follow, which removes
 * them as a follower. Returns whether there was anything to reject.
 */
export const rejectFollow = (
    ctx: Context,
    followerId: string,
    followeeId: string,
): Promise<boolean> => endFollow(ctx, "graph.follow_rejected", followerId, followeeId);

/**
 * Has `followerId` stop following `followeeId`, or withdraw asking to. Returns whether there was
 * anything to stop.
 */
export const unfollow = (ctx: Context, followerId: string, followeeId: string): Promise<boolean> =>
    endFollow(ctx, "graph.unfollowed", followerId, followeeId);
