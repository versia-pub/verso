/**
 * Who follows whom, as Versia shows it: local users' followers and follows, as collections other
 * instances fetch, and follows between local users and other instances' ones, sent and received.
 * @see https://versia.pub/entities/follow
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { findAccount } from "../accounts/accounts.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveries } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { isFollowEvent } from "./events.ts";
import { countFollows, followIdsFrom, followsFrom, type FollowSide } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";

/**
 * A local user's followers or follows, oldest first, so pages stay put as more arrive. A user who
 * hides them shows only how many there are.
 */
const followCollection = (side: FollowSide): CollectionProvider => async (ctx, id, page) => {
    const owner = await findAccount(ctx, id);
    if (owner?.domain !== null) return undefined;

    const total = await countFollows(ctx, side, id);
    if (owner.hide_collections) return { author: id, total, items: [] };

    const ids = await followIdsFrom(ctx, side, id, page.offset, page.limit);
    return { author: id, total, items: await userReferences(ctx, ids) };
};

/** The collections the graph adds to Users. */
export const followCollections: Readonly<Record<FollowSide, CollectionProvider>> = {
    followers: followCollection("followers"),
    following: followCollection("following"),
};

/** Sends a follower's Follow or Unfollow to their followee's instance, if it is another. */
const sendToFollowee = async (
    ctx: Context,
    type: "Follow" | "Unfollow",
    followerId: string,
    followeeId: string,
) => {
    const [author, followee] = await userReferences(ctx, [followerId, followeeId]);
    if (author === undefined || followee === undefined) return;

    const entity: v0_6.Follow | v0_6.Unfollow = {
        type,
        created_at: ctx.clock.now().toISOString(),
        author,
        followee,
    };
    await queueDeliveries(ctx, entity, [followeeId]);
};

/** Sends a followee's answer to their follower's instance, if it is another. */
const sendToFollower = async (
    ctx: Context,
    type: "FollowAccept" | "FollowReject",
    followerId: string,
    followeeId: string,
) => {
    const [author, follower] = await userReferences(ctx, [followeeId, followerId]);
    if (author === undefined || follower === undefined) return;

    const entity: v0_6.FollowAccept | v0_6.FollowReject = {
        type,
        created_at: ctx.clock.now().toISOString(),
        author,
        follower,
    };
    await queueDeliveries(ctx, entity, [followerId]);
};

/**
 * Sends other instances what happened to follows between their users and local ones: a local
 * user's follows and unfollows, to the followee's instance, and a local user's answers, to the
 * follower's. A follow between local users needs nothing sent.
 */
export const followDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isFollowEvent(event)) return;
    const { followerId, followeeId } = event;

    switch (event.type) {
        case "graph.follow_requested":
            return await sendToFollowee(ctx, "Follow", followerId, followeeId);
        case "graph.unfollowed":
            return await sendToFollowee(ctx, "Unfollow", followerId, followeeId);
        case "graph.follow_accepted":
            return await sendToFollower(ctx, "FollowAccept", followerId, followeeId);
        case "graph.follow_rejected":
            return await sendToFollower(ctx, "FollowReject", followerId, followeeId);
    }
};

/** The author of an entity sent by their instance, which only they may send. */
const authorOf = (entity: { author: string }, origin: string) =>
    parseReference(entity.author, origin)?.host;

/**
 * The two users an entity `sender` sent about a follow names: `local`, which must be a user here,
 * and its author, on the sender. Either is `undefined` if Verso doesn't have it.
 */
const partiesOf = async (ctx: Context, local: string, author: string, sender: Sender) => {
    const localUser = parseReference(local, sender.domain);
    if (localUser?.host !== ctx.urls.domain) {
        throw new PermanentFailure(`${local} isn't a user here`);
    }

    // The authority is the author's host, so it is the sender's.
    const remoteUser = parseReference(author, sender.domain);

    return {
        localId: (await knownUser(ctx, localUser))?.id,
        authorId: remoteUser && (await knownUser(ctx, remoteUser))?.id,
    };
};

/**
 * A user asking to follow a local one, who accepts at once unless they are locked. A follower
 * asking again is accepted again, in case their instance missed it.
 */
const followType: EntityType<v0_6.Follow> = {
    type: "Follow",
    schema: v0_6.Follow,
    authority: authorOf,
    // The follower is often new to Verso.
    prepare: async (ctx, entity, sender, budget) => {
        const author = parseReference(entity.author, sender.domain);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
    },
    receive: async (ctx, entity, sender) => {
        const { localId, authorId } = await partiesOf(ctx, entity.followee, entity.author, sender);
        if (localId === undefined || authorId === undefined) return;

        const [existing] = await followsFrom(ctx, authorId, [localId]);
        await follow(ctx, authorId, localId);
        if (existing?.accepted) await sendToFollower(ctx, "FollowAccept", authorId, localId);
    },
};

/** A user no longer following a local one, or no longer asking to. */
const unfollowType: EntityType<v0_6.Unfollow> = {
    type: "Unfollow",
    schema: v0_6.Unfollow,
    authority: authorOf,
    receive: async (ctx, entity, sender) => {
        const { localId, authorId } = await partiesOf(ctx, entity.followee, entity.author, sender);
        if (localId !== undefined && authorId !== undefined) {
            await unfollow(ctx, authorId, localId);
        }
    },
};

/** A user accepting a local user's request to follow them. */
const followAcceptType: EntityType<v0_6.FollowAccept> = {
    type: "FollowAccept",
    schema: v0_6.FollowAccept,
    authority: authorOf,
    receive: async (ctx, entity, sender) => {
        const { localId, authorId } = await partiesOf(ctx, entity.follower, entity.author, sender);
        if (localId !== undefined && authorId !== undefined) {
            await acceptFollow(ctx, localId, authorId);
        }
    },
};

/** A user rejecting a local user's request to follow them, or removing them as a follower. */
const followRejectType: EntityType<v0_6.FollowReject> = {
    type: "FollowReject",
    schema: v0_6.FollowReject,
    authority: authorOf,
    receive: async (ctx, entity, sender) => {
        const { localId, authorId } = await partiesOf(ctx, entity.follower, entity.author, sender);
        if (localId !== undefined && authorId !== undefined) {
            await rejectFollow(ctx, localId, authorId);
        }
    },
};

/** The transient entities follows are sent as. */
export const followTypes: readonly EntityType[] = [
    followType,
    unfollowType,
    followAcceptType,
    followRejectType,
];
