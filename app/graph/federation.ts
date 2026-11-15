/**
 * Who follows whom, as Versia renders it: local users' subscribers and subscriptions, as collections
 * remote instances fetch, and follows between local users and remote users, sent and received as
 * Subscribe, Unsubscribe, SubscribeAccept and SubscribeReject.
 * @see https://versia.pub/entities/subscribe
 * @module
 */
import { parseReference, v0_7 } from "@versia/protocol";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { isProfileUpdated } from "../accounts/events.ts";
import {
    hasPicturesProcessing,
    knownUser,
    localVersiaUser,
    userReferences,
} from "../accounts/federation.ts";
import { queueDeliveries, queueDeliveriesTo } from "../federation/deliver.ts";
import { withHosts } from "../federation/references.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { isFollowEvent } from "./events.ts";
import { countFollows, followIdsFrom, followsFrom, type FollowSide } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";

/**
 * A local user's followers or follows, oldest first, so pages stay stable as more arrive. A user
 * who hides them shows only how many there are.
 */
const followCollection = (side: FollowSide): CollectionProvider => async (ctx, id, page) => {
    const owner = await findAccount(ctx, id);
    if (owner?.domain !== null) return undefined;

    const total = await countFollows(ctx, side, id);
    if (owner.hide_collections) return { author: id, total, items: [] };

    const ids = await followIdsFrom(ctx, side, id, page.offset, page.limit);
    return { author: id, total, items: withHosts(ctx, await userReferences(ctx, ids)) };
};

/** The collections the graph adds to Users. */
export const followCollections: Readonly<
    Record<"subscribers" | "subscriptions", CollectionProvider>
> = {
    subscribers: followCollection("followers"),
    subscriptions: followCollection("following"),
};

/**
 * Sends a subscription entity about a follow to the instance of `recipientId`, if it is remote:
 * the follower's Subscribe or Unsubscribe to the followee's, or the followee's answer to the
 * follower's.
 */
const sendSubscription = async (
    ctx: Context,
    type: "Subscribe" | "Unsubscribe" | "SubscribeAccept" | "SubscribeReject",
    followerId: string,
    followeeId: string,
    recipientId: string,
) => {
    const references = await userReferences(ctx, [followerId, followeeId]);
    // v0.7 references always have a host.
    const [subscriber, target] = withHosts(ctx, references);
    if (subscriber === undefined || target === undefined) return;

    const entity = {
        type,
        created_at: ctx.clock.now().toISOString(),
        subscriber,
        target,
        target_type: "User",
    };

    await queueDeliveries(ctx, entity, [recipientId]);
};

/** Sends a follower's Subscribe or Unsubscribe to their followee's instance, if it is remote. */
const sendToFollowee = (
    ctx: Context,
    type: "Subscribe" | "Unsubscribe",
    followerId: string,
    followeeId: string,
) => sendSubscription(ctx, type, followerId, followeeId, followeeId);

/** Sends a followee's response to their follower's instance, if it is remote. */
const sendToFollower = (
    ctx: Context,
    type: "SubscribeAccept" | "SubscribeReject",
    followerId: string,
    followeeId: string,
) => sendSubscription(ctx, type, followerId, followeeId, followerId);

/**
 * Sends remote instances what happened to follows between their users and local ones: a local
 * user's Subscribes and Unsubscribes, to the followee's instance, and a local user's responses,
 * to the follower's. A follow between local users needs nothing sent.
 */
export const followDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isFollowEvent(event)) return;
    const { followerId, followeeId } = event;

    switch (event.type) {
        case "graph.follow_requested":
            return await sendToFollowee(ctx, "Subscribe", followerId, followeeId);
        case "graph.unfollowed":
            return await sendToFollowee(ctx, "Unsubscribe", followerId, followeeId);
        case "graph.follow_accepted":
            return await sendToFollower(ctx, "SubscribeAccept", followerId, followeeId);
        case "graph.follow_rejected":
            return await sendToFollower(ctx, "SubscribeReject", followerId, followeeId);
    }
};

/**
 * Sends a local user's changed profile to their followers' instances, once its new pictures are
 * processed; it is sent again then.
 */
export const profileDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isProfileUpdated(event)) return;
    if (await hasPicturesProcessing(ctx, event.accountId)) return;

    const user = await localVersiaUser(ctx, event.accountId);
    if (user === undefined) return;

    await queueDeliveriesTo(ctx, user, { instanceIds: [], followersOf: event.accountId });
};

/** The instance of the subscriber of an entity, which only it may send. */
const subscriberHost = (entity: { subscriber: string }, origin: string) =>
    parseReference(entity.subscriber, origin)?.host;

/** The instance of the target of an entity, which only it may send. */
const targetHost = (entity: { target: string }, origin: string) =>
    parseReference(entity.target, origin)?.host;

/**
 * The two users named by a subscription entity sent by `sender`: `local`, which must be a local
 * user, and `remote`, on the sender. Either is `undefined` if Verso doesn't have it.
 */
const partiesOf = async (ctx: Context, local: string, remote: string, sender: Sender) => {
    const localUser = parseReference(local, sender.domain);
    if (localUser?.host !== ctx.urls.domain) {
        throw new PermanentFailure(`${local} isn't a user here`);
    }

    // The authority is the sender's host, which is the remote user's.
    const remoteUser = parseReference(remote, sender.domain);

    return {
        localId: (await knownUser(ctx, localUser))?.id,
        remoteId: remoteUser && (await knownUser(ctx, remoteUser))?.id,
    };
};

// Verso only has subscribable Users, so any other `target_type` is invalid.
const Subscribe = v0_7.Subscribe.extend({ target_type: z.literal("User") });
const Unsubscribe = v0_7.Unsubscribe.extend({ target_type: z.literal("User") });
const SubscribeAccept = v0_7.SubscribeAccept.extend({ target_type: z.literal("User") });
const SubscribeReject = v0_7.SubscribeReject.extend({ target_type: z.literal("User") });

/**
 * A user requesting to follow a local one. It is accepted at once, unless the local user is locked
 * or the follower is silenced, which leaves it waiting for the local user to answer. A follower
 * requesting again is accepted again, in case their instance missed it. A Subscribe to a user who
 * can't be followed, because they are suspended or moved, or naming a user Verso doesn't have, is
 * rejected.
 */
const subscribeType: EntityType<z.infer<typeof Subscribe>> = {
    type: "Subscribe",
    schema: Subscribe,
    authority: subscriberHost,
    // The follower is often new to Verso.
    prepare: async (ctx, entity, sender, budget) => {
        const subscriber = parseReference(entity.subscriber, sender.domain);
        if (subscriber) await ctx.federation.resolve(ctx, subscriber, "User", budget);
    },
    receive: async (ctx, entity, sender) => {
        const { localId, remoteId } = await partiesOf(
            ctx,
            entity.target,
            entity.subscriber,
            sender,
        );
        // Every Subscribe is answered, so one Verso can't apply is rejected back to its sender.
        if (localId === undefined || remoteId === undefined) {
            const { subscriber, target, target_type } = entity;
            const reject = {
                type: "SubscribeReject",
                created_at: ctx.clock.now().toISOString(),
                subscriber,
                target,
                target_type,
            };

            return await queueDeliveriesTo(ctx, reject, { instanceIds: [sender.instanceId] });
        }

        const [existing] = await followsFrom(ctx, remoteId, [localId]);
        const result = await follow(ctx, remoteId, localId);

        // Every Subscribe is answered. A new follow was answered when `follow` emitted it.
        if (result === "missing" || result === "moved") {
            await sendToFollower(ctx, "SubscribeReject", remoteId, localId);
        } else if (existing?.accepted) {
            await sendToFollower(ctx, "SubscribeAccept", remoteId, localId);
        }
    },
};

/** A user who no longer follows a local one, or no longer requests to. */
const unsubscribeType: EntityType<z.infer<typeof Unsubscribe>> = {
    type: "Unsubscribe",
    schema: Unsubscribe,
    authority: subscriberHost,
    receive: async (ctx, entity, sender) => {
        const { localId, remoteId } = await partiesOf(
            ctx,
            entity.target,
            entity.subscriber,
            sender,
        );
        if (localId !== undefined && remoteId !== undefined) {
            await unfollow(ctx, remoteId, localId);
        }
    },
};

/**
 * A user accepting a local user's follow request. If Verso has neither a request nor a follow, the
 * user is told to stop, as the spec says.
 */
const subscribeAcceptType: EntityType<z.infer<typeof SubscribeAccept>> = {
    type: "SubscribeAccept",
    schema: SubscribeAccept,
    authority: targetHost,
    receive: async (ctx, entity, sender) => {
        const { localId, remoteId } = await partiesOf(
            ctx,
            entity.subscriber,
            entity.target,
            sender,
        );
        if (localId === undefined || remoteId === undefined) return;

        const [existing] = await followsFrom(ctx, localId, [remoteId]);
        if (existing === undefined) {
            await sendToFollowee(ctx, "Unsubscribe", localId, remoteId);
            return;
        }

        await acceptFollow(ctx, localId, remoteId);
    },
};

/** A user rejecting a local user's follow request, or removing them as a follower. */
const subscribeRejectType: EntityType<z.infer<typeof SubscribeReject>> = {
    type: "SubscribeReject",
    schema: SubscribeReject,
    authority: targetHost,
    receive: async (ctx, entity, sender) => {
        const { localId, remoteId } = await partiesOf(
            ctx,
            entity.subscriber,
            entity.target,
            sender,
        );
        if (localId !== undefined && remoteId !== undefined) {
            await rejectFollow(ctx, localId, remoteId);
        }
    },
};

/** The transient entities that follows are sent as. */
export const followTypes: readonly EntityType[] = [
    subscribeType,
    unsubscribeType,
    subscribeAcceptType,
    subscribeRejectType,
];
