/**
 * Following accounts, on this instance or another.
 * @module
 */
import {
    countFollow,
    findAccount,
    uncountFollowers,
    uncountFollowing,
} from "../accounts/accounts.ts";
import { isAccountDeleting, isProfileUpdated } from "../accounts/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { FollowEvent } from "./events.ts";
import {
    acceptPendingFollow,
    type AccountIdQuery,
    anyListed,
    countFollows,
    deleteFollow,
    everyListed,
    followedIdsQuery,
    followerInstanceIds,
    type FollowOptions,
    followsFrom,
    insertFollow,
    updateFollowOptions,
} from "./follow_queries.ts";

export type { AccountIdQuery };

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

/**
 * Removes a follow, or a request for one, and says why. With `accepted`, it only removes a follow,
 * or only a request.
 */
const endFollow = (
    ctx: Context,
    type: "graph.follow_rejected" | "graph.unfollowed",
    followerId: string,
    followeeId: string,
    accepted?: boolean,
) => ctx.transaction(async (tx) => {
    const removed = await deleteFollow(tx, followerId, followeeId, accepted);
    if (removed === undefined) return false;

    if (removed.accepted) await countFollow(tx, followerId, followeeId, -1);
    await emitFollow(tx, type, followerId, followeeId);

    return true;
});

/**
 * Has `followeeId` reject `followerId`: their request to follow, or their follow, which removes
 * them as a follower. With `accepted`, it only rejects a follower, or only a request. Returns
 * whether there was anything to reject.
 */
export const rejectFollow = (
    ctx: Context,
    followerId: string,
    followeeId: string,
    accepted?: boolean,
): Promise<boolean> => endFollow(ctx, "graph.follow_rejected", followerId, followeeId, accepted);

/**
 * Has `followerId` stop following `followeeId`, or withdraw asking to. Returns whether there was
 * anything to stop.
 */
export const unfollow = (ctx: Context, followerId: string, followeeId: string): Promise<boolean> =>
    endFollow(ctx, "graph.unfollowed", followerId, followeeId);

/** How many accounts are asking to follow `accountId`. */
export const countFollowRequests = (ctx: Context, accountId: string): Promise<number> =>
    countFollows(ctx, "requests", accountId);

/** Accepts everyone asking to follow an account once it is unlocked, as Mastodon does. */
export const acceptWhenUnlocked = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isProfileUpdated(event) || !event.unlocked) return;

    for (const followerId of await everyListed(ctx, "requests", event.accountId)) {
        await acceptFollow(ctx, followerId, event.accountId);
    }
};

/** Whether `followerId` follows `followeeId`, and was accepted. */
export const isFollowing = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
): Promise<boolean> => {
    const [follow] = await followsFrom(ctx, followerId, [followeeId]);
    return follow?.accepted === true;
};

/** The other instances that accounts following `accountId`, and accepted, are on. */
export const followerInstances = (ctx: Context, accountId: string): Promise<string[]> =>
    followerInstanceIds(ctx, accountId);

/** The accounts `accountId` follows, and was accepted by, as a subquery, for timelines. */
export const followedIds = (
    ctx: Context,
    accountId: string,
): AccountIdQuery => followedIdsQuery(ctx, accountId);

/** Whether anyone follows `accountId`, and was accepted. */
export const hasFollowers = (ctx: Context, accountId: string): Promise<boolean> =>
    anyListed(ctx, "followers", accountId);

/**
 * Uncounts the follows of an account about to be deleted, from the accounts on their other side,
 * before the follows go with it. Requests were never counted.
 */
export const uncountFollowsOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isAccountDeleting(event)) return;
    const { accountId } = event;

    await uncountFollowers(ctx, await everyListed(ctx, "following", accountId));
    await uncountFollowing(ctx, await everyListed(ctx, "followers", accountId));
};
