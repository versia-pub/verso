import type { Selectable, SelectQueryBuilder } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { FollowsTable } from "./tables.ts";

export type FollowRow = Selectable<FollowsTable>;

/** Accounts given as a subquery, for another module's query to use. */
export type AccountIdQuery = SelectQueryBuilder<Database, "follows", { account_id: string }>;

/** How a follower wants to see the account they follow. Options left out stay as they are. */
export type FollowOptions = {
    readonly showReblogs?: boolean;
    readonly notify?: boolean;
    /** `null` for all. */
    readonly languages?: readonly string[] | null;
};

const columnsOf = (options: FollowOptions) => ({
    show_reblogs: options.showReblogs,
    notify: options.notify,
    languages: options.languages && [...options.languages],
});

/**
 * Adds a follow, unless the follower already follows or asked to follow the followee. Returns it
 * if it was added.
 */
export const insertFollow = async (
    ctx: Context,
    follow: {
        readonly followerId: string;
        readonly followeeId: string;
        readonly accepted: boolean;
        readonly options: FollowOptions;
    },
): Promise<FollowRow | undefined> =>
    await ctx.db.insertInto("follows")
        .values({
            id: ctx.ids(),
            follower_id: follow.followerId,
            followee_id: follow.followeeId,
            accepted: follow.accepted,
            ...columnsOf(follow.options),
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["follower_id", "followee_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();

/** Changes how a follower sees an account they follow or asked to follow. */
export const updateFollowOptions = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
    options: FollowOptions,
): Promise<void> => {
    const changes = columnsOf(options);
    // Kysely leaves out the columns set to `undefined`, and an update must set something.
    if (Object.values(changes).every((value) => value === undefined)) return;

    await ctx.db.updateTable("follows")
        .set(changes)
        .where("follower_id", "=", followerId)
        .where("followee_id", "=", followeeId)
        .execute();
};

/** Accepts a request to follow. Returns whether there was one, rather than a follow or nothing. */
export const acceptPendingFollow = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
): Promise<boolean> => {
    const { numUpdatedRows } = await ctx.db.updateTable("follows")
        .set({ accepted: true })
        .where("follower_id", "=", followerId)
        .where("followee_id", "=", followeeId)
        .where("accepted", "=", false)
        .executeTakeFirst();

    return numUpdatedRows > 0n;
};

/**
 * Removes a follow or a request to follow, and returns it, if there was one. With `accepted`, it
 * only removes a follow, or only a request.
 */
export const deleteFollow = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
    accepted?: boolean,
): Promise<FollowRow | undefined> => {
    let query = ctx.db.deleteFrom("follows")
        .where("follower_id", "=", followerId)
        .where("followee_id", "=", followeeId);
    if (accepted !== undefined) query = query.where("accepted", "=", accepted);

    return await query.returningAll().executeTakeFirst();
};

/** The follows and requests from `followerId` of any of `followeeIds`. */
export const followsFrom = async (
    ctx: Context,
    followerId: string,
    followeeIds: readonly string[],
): Promise<FollowRow[]> =>
    followeeIds.length === 0 ? [] : await ctx.db.selectFrom("follows")
        .selectAll()
        .where("follower_id", "=", followerId)
        .where("followee_id", "in", followeeIds)
        .execute();

/** The follows and requests of `followeeId` from any of `followerIds`. */
export const followsOf = async (
    ctx: Context,
    followeeId: string,
    followerIds: readonly string[],
): Promise<FollowRow[]> =>
    followerIds.length === 0 ? [] : await ctx.db.selectFrom("follows")
        .selectAll()
        .where("followee_id", "=", followeeId)
        .where("follower_id", "in", followerIds)
        .execute();

/** An account's followers, or the accounts it follows. */
export type FollowSide = "followers" | "following";

/** An account's followers, the accounts it follows, or the accounts asking to follow it. */
export type FollowList = FollowSide | "requests";

/**
 * For each list, the column naming the account it is of, the one naming who is listed, and
 * whether its follows are accepted.
 */
const lists = {
    followers: { of: "followee_id", listed: "follower_id", accepted: true },
    following: { of: "follower_id", listed: "followee_id", accepted: true },
    requests: { of: "followee_id", listed: "follower_id", accepted: false },
} as const;

const listed = (ctx: Context, list: FollowList, accountId: string) =>
    ctx.db.selectFrom("follows")
        .where(lists[list].of, "=", accountId)
        .where("accepted", "=", lists[list].accepted);

/**
 * A page of one of an account's lists, newest first, each as the follow's id, which pages are
 * counted by, and the listed account's.
 */
export const followPage = async (
    ctx: Context,
    list: FollowList,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; account_id: string }[]> =>
    await readPage(
        listed(ctx, list, accountId).select(["id", `${lists[list].listed} as account_id`]),
        "follows.id",
        page,
    );

/** The ids of the accounts on one of an account's lists, from `offset`, oldest first. */
export const followIdsFrom = async (
    ctx: Context,
    list: FollowList,
    accountId: string,
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await listed(ctx, list, accountId)
        .select(`${lists[list].listed} as account_id`)
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.account_id);

/** The ids of every account on one of an account's lists. */
export const everyListed = async (
    ctx: Context,
    list: FollowList,
    accountId: string,
): Promise<string[]> =>
    (await listed(ctx, list, accountId).select(`${lists[list].listed} as account_id`).execute())
        .map((row) => row.account_id);

/** Whether an account has anyone on one of its lists. */
export const anyListed = async (
    ctx: Context,
    list: FollowList,
    accountId: string,
): Promise<boolean> =>
    await listed(ctx, list, accountId).select("id").limit(1).executeTakeFirst() !== undefined;

/**
 * The instances an account's followers are on, other than this one. The one query here that reads
 * another module's table: an account can have more followers than a query can name, so their
 * instances are found by joining their accounts, rather than by listing them.
 */
export const followerInstanceIds = async (ctx: Context, accountId: string): Promise<string[]> =>
    (await listed(ctx, "followers", accountId)
        .innerJoin("accounts", "accounts.id", "follows.follower_id")
        .select("accounts.instance_id")
        .distinct()
        .execute())
        // Local accounts have none.
        .flatMap((row) => row.instance_id ?? []);

/**
 * Whether any of an account's followers is on the instance `instanceId`, joining their accounts as
 * {@link followerInstanceIds} does, but stopping at the first.
 */
export const anyFollowerOn = async (
    ctx: Context,
    accountId: string,
    instanceId: string,
): Promise<boolean> =>
    await listed(ctx, "followers", accountId)
        .innerJoin("accounts", "accounts.id", "follows.follower_id")
        .where("accounts.instance_id", "=", instanceId)
        .select("follows.id")
        .limit(1)
        .executeTakeFirst() !== undefined;

/**
 * The accounts `accountId` follows, as a subquery, for another module to page through what they
 * wrote. The other exception to keeping queries to a module's own tables: someone can follow more
 * accounts than a query can name, and a page sorted across them all can't be read in batches.
 */
export const followedIdsQuery = (
    ctx: Context,
    accountId: string,
): AccountIdQuery => listed(ctx, "following", accountId).select("followee_id as account_id");

/** The accounts an account follows and sees the shares of, as a subquery. */
export const sharingIdsQuery = (ctx: Context, accountId: string): AccountIdQuery =>
    listed(ctx, "following", accountId).where("show_reblogs", "=", true)
        .select("followee_id as account_id");

/** How many accounts are on one of an account's lists. */
export const countFollows = async (
    ctx: Context,
    list: FollowList,
    accountId: string,
): Promise<number> =>
    readCount(await listed(ctx, list, accountId).select(countAll).executeTakeFirstOrThrow());
