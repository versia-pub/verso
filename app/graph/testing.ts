import { batchesOf } from "../db/batches.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Adds `count` accounts following `followeeId`, accepted and counted, spread in turn over
 * `instanceIds`, where `null` is the local instance, as quickly as the database allows. Returns
 * their ids, `follower0` onwards.
 */
export const addFollowers = async (
    ctx: Context,
    followeeId: string,
    count: number,
    instanceIds: readonly (string | null)[],
): Promise<string[]> => {
    const ids = Array.from({ length: count }, (_, i) => `follower${i}`);

    for (const batch of batchesOf(ids.map((id, i) => ({ id, i })), 500)) {
        await ctx.db.insertInto("accounts")
            .values(batch.map(({ id, i }) => {
                const instanceId = instanceIds[i % instanceIds.length];
                return {
                    id,
                    username: id,
                    instance_id: instanceId,
                    remote_id: instanceId === null ? null : id,
                    following_count: 1,
                    created_at: ctx.clock.now(),
                    fetched_at: instanceId === null ? null : ctx.clock.now(),
                };
            }))
            .execute();
        await ctx.db.insertInto("follows")
            .values(batch.map(({ id }) => ({
                id: ctx.ids(),
                follower_id: id,
                followee_id: followeeId,
                accepted: true,
                created_at: ctx.clock.now(),
            })))
            .execute();
    }

    await ctx.db.updateTable("accounts")
        .set((eb) => ({ followers_count: eb("followers_count", "+", count) }))
        .where("id", "=", followeeId)
        .execute();

    return ids;
};
