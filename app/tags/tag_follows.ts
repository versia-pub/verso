/**
 * Followed hashtags: hashtags whose public statuses, local or remote, are on the home timelines
 * of the local users who follow them, as on Mastodon. Versia has no followed hashtags, so they
 * aren't federated.
 * @see https://docs.joinmastodon.org/methods/tags/#follow
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { deleteTagFollow, insertTagFollow } from "./tag_follow_queries.ts";
import { insertTags } from "./tag_queries.ts";

/** Has `accountId` follow the hashtag `name`, which must be a hashtag's name, unless it does. */
export const followTag = (ctx: Context, accountId: string, name: string): Promise<void> =>
    ctx.transaction(async (tx) => {
        // As on Mastodon, users may follow hashtags no status has used yet.
        await insertTags(tx, [name]);
        await insertTagFollow(tx, accountId, name.toLowerCase());
    });

/** Stops `accountId` following the hashtag `name`. */
export const unfollowTag = async (ctx: Context, accountId: string, name: string): Promise<void> => {
    await deleteTagFollow(ctx, accountId, name.toLowerCase());
};
