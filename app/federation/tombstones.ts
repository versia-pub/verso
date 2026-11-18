/**
 * Tombstones: what Verso remembers of local entities that were deleted. Fetching one answers `410
 * Gone`, and its queued deliveries are dropped.
 * @see https://versia.pub/entities/delete
 * @module
 */
import { v0_7 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import { type Audience, dropDeliveriesOf, queueDeliveriesTo } from "./deliver.ts";

/** A Delete by the local user `authorId` of their entity `deleted`, of `deletedType`, dated now. */
export const deleteEntity = (
    ctx: Context,
    authorId: string,
    deletedType: string,
    deleted: string,
): v0_7.Delete => ({
    type: "Delete",
    created_at: ctx.clock.now().toISOString(),
    author: v0_7.formatReference({ host: ctx.urls.domain, id: authorId }),
    deleted_type: deletedType,
    deleted: v0_7.formatReference({ host: ctx.urls.domain, id: deleted }),
});

/**
 * How long a tombstone is kept: the longest an instance may try to deliver an entity (30 days).
 * One that was delayed that long may still make it fetch the entity once it arrives.
 */
const tombstoneMs = 30 * 24 * 3_600_000;

/**
 * Records that the local entity `deletedId`, of Versia type `deletedType`, is deleted, drops its
 * queued deliveries, and queues a Delete of it by the local user `authorId` to `audience`. The
 * tombstone and the drop happen even if the audience is empty.
 */
export const queueDelete = async (
    ctx: Context,
    authorId: string,
    deletedType: string,
    deletedId: string,
    audience: Audience,
): Promise<void> => {
    await ctx.db.insertInto("deleted_entities")
        .values({ id: deletedId, type: deletedType, deleted_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.doNothing())
        .execute();

    // Only what was queued before is dropped. The Delete follows, and must be sent.
    await dropDeliveriesOf(ctx, deletedId);

    await queueDeliveriesTo(ctx, deleteEntity(ctx, authorId, deletedType, deletedId), audience);
};

/** Whether the local entity `id` was deleted as a `type`, a Versia type name. */
export const isDeleted = async (ctx: Context, type: string, id: string): Promise<boolean> => {
    const row = await ctx.db.selectFrom("deleted_entities").select("id").where("id", "=", id)
        .where("type", "=", type).executeTakeFirst();

    return row !== undefined;
};

/** Deletes the tombstones older than 30 days, `batchSize` at a time. */
export const deleteExpiredTombstones = async (ctx: Context, batchSize = 1000): Promise<void> => {
    const before = new Date(ctx.clock.now().getTime() - tombstoneMs);
    for (;;) {
        const deleted = await ctx.db.deleteFrom("deleted_entities")
            .where(
                "id",
                "in",
                ctx.db.selectFrom("deleted_entities").select("id").where("deleted_at", "<=", before)
                    .limit(batchSize),
            )
            .executeTakeFirst();
        if (deleted.numDeletedRows < BigInt(batchSize)) break;
    }
};
