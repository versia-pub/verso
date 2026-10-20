/**
 * Who follows whom, as Versia shows it: local users' followers and follows, as collections other
 * instances fetch.
 * @module
 */
import { findAccount } from "../accounts/accounts.ts";
import { userReferences } from "../accounts/federation.ts";
import type { CollectionProvider } from "../federation/registry.ts";
import { countFollows, followIdsFrom, type FollowSide } from "./follow_queries.ts";

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
