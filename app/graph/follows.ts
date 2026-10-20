/**
 * Following accounts, on this instance or another.
 * @module
 */
import { countFollow, findAccount } from "../accounts/accounts.ts";
import type { Context } from "../kernel/context.ts";
import {
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

        if (added?.accepted) await countFollow(tx, followerId, followeeId, 1);
        if (added) return accepted ? "following" : "requested";

        await updateFollowOptions(tx, followerId, followeeId, options);
        const [existing] = await followsFrom(tx, followerId, [followeeId]);

        return existing?.accepted ? "following" : "requested";
    });

/**
 * Has `followerId` stop following `followeeId`, or withdraw asking to. Returns whether there was
 * anything to stop.
 */
export const unfollow = (ctx: Context, followerId: string, followeeId: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        const removed = await deleteFollow(tx, followerId, followeeId);
        if (removed?.accepted) await countFollow(tx, followerId, followeeId, -1);

        return removed !== undefined;
    });
