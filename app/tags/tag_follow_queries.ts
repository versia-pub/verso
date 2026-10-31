import type { SelectQueryBuilder } from "kysely";
import { batchesOf } from "../db/batches.ts";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";

/** A query of hashtags' names, in lower case, for use as a subquery. */
export type TagNameQuery = SelectQueryBuilder<Database, keyof Database, { tag: string }>;

/** Has `accountId` follow the hashtag `tag`, which is in `tags`, unless it already does. */
export const insertTagFollow = async (
    ctx: Context,
    accountId: string,
    tag: string,
): Promise<void> => {
    await ctx.db.insertInto("tag_follows")
        .values({ id: ctx.ids(), account_id: accountId, tag, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.columns(["account_id", "tag"]).doNothing())
        .execute();
};

/** Stops `accountId` following the hashtag `tag`. */
export const deleteTagFollow = async (
    ctx: Context,
    accountId: string,
    tag: string,
): Promise<void> => {
    await ctx.db.deleteFrom("tag_follows")
        .where("account_id", "=", accountId)
        .where("tag", "=", tag)
        .execute();
};

/** Which of the hashtags `tags`, in lower case, `accountId` follows. */
export const followedTagsAmong = async (
    ctx: Context,
    accountId: string,
    tags: readonly string[],
): Promise<Set<string>> => {
    if (tags.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("tag_follows").select("tag")
        .where("account_id", "=", accountId)
        .where("tag", "in", tags)
        .execute();
    return new Set(rows.map((row) => row.tag));
};

/** The hashtags `accountId` follows, as a subquery, for its home timeline. */
export const followedTagsSubquery = (ctx: Context, accountId: string): TagNameQuery =>
    ctx.db.selectFrom("tag_follows").select("tag_follows.tag")
        .where("tag_follows.account_id", "=", accountId);

/**
 * Which of `accountIds` follow any of the hashtags `tags`, in lower case, which are as few as a
 * status may have. The accounts are asked about in batches.
 */
export const tagFollowersAmong = async (
    ctx: Context,
    tags: readonly string[],
    accountIds: readonly string[],
): Promise<Set<string>> => {
    const followers = new Set<string>();
    if (tags.length === 0) return followers;

    for (const asked of batchesOf(accountIds)) {
        const rows = await ctx.db.selectFrom("tag_follows").select("account_id").distinct()
            .where("tag", "in", tags)
            .where("account_id", "in", asked)
            .execute();
        for (const row of rows) followers.add(row.account_id);
    }

    return followers;
};

/** Which of `accountIds` follow any hashtag. They are asked about in batches. */
export const followingAnyTagAmong = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<Set<string>> => {
    const following = new Set<string>();
    for (const asked of batchesOf(accountIds)) {
        const rows = await ctx.db.selectFrom("tag_follows").select("account_id").distinct()
            .where("account_id", "in", asked)
            .execute();
        for (const row of rows) following.add(row.account_id);
    }

    return following;
};

/**
 * A page of the hashtags `accountId` follows, latest followed first, each as the follow's id,
 * which pages are counted by, and the hashtag's name.
 */
export const tagFollowPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; tag: string }[]> =>
    await readPage(
        ctx.db.selectFrom("tag_follows")
            .select(["id", "tag"])
            .where("account_id", "=", accountId),
        "tag_follows.id",
        page,
    );
