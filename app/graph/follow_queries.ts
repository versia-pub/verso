import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { FollowsTable } from "./tables.ts";

export type FollowRow = Selectable<FollowsTable>;

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

/** Removes a follow or a request to follow, and returns it, if there was one. */
export const deleteFollow = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
): Promise<FollowRow | undefined> =>
    await ctx.db.deleteFrom("follows")
        .where("follower_id", "=", followerId)
        .where("followee_id", "=", followeeId)
        .returningAll()
        .executeTakeFirst();

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
