import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";

/** Has `accountId` feature `targetId`, unless it already does. */
export const insertEndorsement = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<void> => {
    await ctx.db.insertInto("endorsements")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            target_id: targetId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "target_id"]).doNothing())
        .execute();
};

/** Stops `accountId` featuring `targetId`. */
export const deleteEndorsement = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<void> => {
    await ctx.db.deleteFrom("endorsements")
        .where("account_id", "=", accountId)
        .where("target_id", "=", targetId)
        .execute();
};

/** Which of `otherIds` `accountId` features. */
export const endorsedAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Set<string>> => {
    if (otherIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("endorsements").select("target_id")
        .where("account_id", "=", accountId)
        .where("target_id", "in", otherIds)
        .execute();
    return new Set(rows.map((row) => row.target_id));
};

/**
 * A page of the accounts `accountId` features, latest featured first, each as the endorsement's
 * id, which pages are counted by, and the featured account's id.
 */
export const endorsementPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; account_id: string }[]> =>
    await readPage(
        ctx.db.selectFrom("endorsements")
            .select(["id", "target_id as account_id"])
            .where("account_id", "=", accountId),
        "endorsements.id",
        page,
    );
