/**
 * Following accounts, on this instance or another.
 * @module
 */
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { countFollow, uncountFollowers, uncountFollowing } from "../accounts/count_queries.ts";
import { isAccountDeleting, isProfileUpdated } from "../accounts/events.ts";
import { batchSize } from "../db/batches.ts";
import { enqueue } from "../jobs/queue.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { FollowEvent } from "./events.ts";
import {
    acceptPendingFollow,
    type AccountIdQuery,
    anyFollowerOn,
    anyListed,
    countFollows,
    deleteFollow,
    everyListedQuery,
    followedIdsQuery,
    followerInstanceIds,
    followIdsFrom,
    type FollowOptions,
    followsFrom,
    insertFollow,
    sharingIdsQuery,
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
 * Has `followerId` follow `followeeId`, or ask to, if the followee is locked or on another
 * instance, which accepts for it. Following again only changes the options given.
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

/** The queue that accepts everyone asking to follow an account that was unlocked. */
export const acceptQueue = "follow-requests";

const AcceptJob = z.object({ accountId: z.string() });

/**
 * Accepts everyone asking to follow an account once it is unlocked, as Mastodon does. A job does
 * it, so an account many are asking to follow can be saved at once.
 */
export const acceptWhenUnlocked = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isProfileUpdated(event) || !event.unlocked) return;

    const payload: z.infer<typeof AcceptJob> = { accountId: event.accountId };
    await enqueue(ctx, { queue: acceptQueue, payload, dedupeKey: `accept:${event.accountId}` });
};

/**
 * Accepts the requests to follow the account in the job, a batch at a time, until none are left.
 */
export const acceptHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = AcceptJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a follow request job");
    const { accountId } = payload.data;

    for (;;) {
        const followerIds = await followIdsFrom(ctx, "requests", accountId, 0, batchSize);
        if (followerIds.length === 0) return;

        await ctx.transaction(async (tx) => {
            for (const followerId of followerIds) await acceptFollow(tx, followerId, accountId);
        });
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

/** Whether an account following `accountId`, and accepted, is on the instance `instanceId`. */
export const hasFollowersOn = (
    ctx: Context,
    accountId: string,
    instanceId: string,
): Promise<boolean> => anyFollowerOn(ctx, accountId, instanceId);

/** The other instances that accounts following `accountId`, and accepted, are on. */
export const followerInstances = (ctx: Context, accountId: string): Promise<string[]> =>
    followerInstanceIds(ctx, accountId);

/**
 * The accounts `accountId` follows, and was accepted by, as a subquery, for timelines and threads.
 */
export const followedSubquery = (
    ctx: Context,
    accountId: string,
): AccountIdQuery => followedIdsQuery(ctx, accountId);

/**
 * The accounts `accountId` follows, and was accepted by, whose shares it sees, which is all of them
 * unless it chose not to, as a subquery, for its home timeline.
 */
export const sharingSubquery = (ctx: Context, accountId: string): AccountIdQuery =>
    sharingIdsQuery(ctx, accountId);

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

    await uncountFollowers(ctx, everyListedQuery(ctx, "following", accountId));
    await uncountFollowing(ctx, everyListedQuery(ctx, "followers", accountId));
};
