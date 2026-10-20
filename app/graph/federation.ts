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
import { type FollowEvent, isFollowEvent } from "./events.ts";
import { countFollows, followIdsFrom, type FollowSide } from "./follow_queries.ts";
import { acceptFollow, rejectFollow } from "./follows.ts";

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

/** What a local follower's instance sends their followee's, for each event. */
const sentToFollowee: Partial<Record<FollowEvent["type"], "Follow" | "Unfollow">> = {
    "graph.follow_requested": "Follow",
    "graph.unfollowed": "Unfollow",
};

/**
 * Sends other instances what happened to follows between their users and local ones: a local
 * user's follows and unfollows, to the followee's instance. Other instances' users only follow
 * local ones, which need nothing sent.
 */
export const followDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isFollowEvent(event)) return;
    const type = sentToFollowee[event.type];
    if (type === undefined) return;

    const [author, followee] = await userReferences(ctx, [event.followerId, event.followeeId]);
    if (author === undefined || followee === undefined) return;

    const entity: v0_6.Follow | v0_6.Unfollow = {
        type,
        created_at: ctx.clock.now().toISOString(),
        author,
        followee,
    };
    await queueDeliveries(ctx, entity, [event.followeeId]);
};

/** The author of an entity sent by their instance, which only they may send. */
const authorOf = (entity: { author: string }, origin: string) =>
    parseReference(entity.author, origin)?.host;

/**
 * The local follower and remote followee an answer to a follow is about, if Verso has both: if it
 * hasn't, there can't be a follow to answer.
 */
const answered = async (
    ctx: Context,
    answer: v0_6.FollowAccept | v0_6.FollowReject,
    sender: Sender,
) => {
    const follower = parseReference(answer.follower, sender.domain);
    if (follower?.host !== ctx.urls.domain) {
        throw new PermanentFailure(`${answer.follower} isn't a user here`);
    }

    // The authority is the author's host, so it is the sender's.
    const author = parseReference(answer.author, sender.domain);
    const followerId = (await knownUser(ctx, follower))?.id;
    const followeeId = author && (await knownUser(ctx, author))?.id;

    return followerId && followeeId ? { followerId, followeeId } : undefined;
};

/** A user accepting a local user's request to follow them. */
const followAcceptType: EntityType<v0_6.FollowAccept> = {
    type: "FollowAccept",
    schema: v0_6.FollowAccept,
    authority: authorOf,
    receive: async (ctx, entity, sender) => {
        const follow = await answered(ctx, entity, sender);
        if (follow) await acceptFollow(ctx, follow.followerId, follow.followeeId);
    },
};

/** A user rejecting a local user's request to follow them, or removing them as a follower. */
const followRejectType: EntityType<v0_6.FollowReject> = {
    type: "FollowReject",
    schema: v0_6.FollowReject,
    authority: authorOf,
    receive: async (ctx, entity, sender) => {
        const follow = await answered(ctx, entity, sender);
        if (follow) await rejectFollow(ctx, follow.followerId, follow.followeeId);
    },
};

/** The transient entities follows are sent as. */
export const followTypes: readonly EntityType[] = [followAcceptType, followRejectType];
