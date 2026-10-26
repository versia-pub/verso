import type { Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountIdQuery } from "./follow_queries.ts";
import type { BlocksTable } from "./tables.ts";

export type BlockRow = Selectable<BlocksTable>;

/** Adds a block, unless the account already blocks the target. */
export const insertBlock = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<void> => {
    await ctx.db.insertInto("blocks")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            target_id: targetId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "target_id"]).doNothing())
        .execute();
};

/** Removes a block. Returns whether there was one. */
export const deleteBlock = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<boolean> =>
    (await ctx.db.deleteFrom("blocks")
        .where("account_id", "=", accountId)
        .where("target_id", "=", targetId)
        .returning("id")
        .executeTakeFirst()) !== undefined;

/** Which of `otherIds` `accountId` blocks, and which of them block it. */
export const blocksBetween = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<{ blocking: Set<string>; blockedBy: Set<string> }> => {
    if (otherIds.length === 0) return { blocking: new Set(), blockedBy: new Set() };

    const rows = await ctx.db.selectFrom("blocks")
        .select(["account_id", "target_id"])
        .where((eb) =>
            eb.or([
                eb.and([eb("account_id", "=", accountId), eb("target_id", "in", otherIds)]),
                eb.and([eb("target_id", "=", accountId), eb("account_id", "in", otherIds)]),
            ])
        )
        .execute();

    return {
        blocking: new Set(
            rows.filter((row) => row.account_id === accountId).map((row) => row.target_id),
        ),
        blockedBy: new Set(
            rows.filter((row) => row.target_id === accountId).map((row) => row.account_id),
        ),
    };
};

/**
 * A page of the accounts `accountId` blocks, latest blocked first, each as the block's id, which
 * pages are counted by, and the blocked account's id.
 */
export const blockPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; account_id: string }[]> =>
    await readPage(
        ctx.db.selectFrom("blocks")
            .select(["id", "target_id as account_id"])
            .where("account_id", "=", accountId),
        "blocks.id",
        page,
    );

/** The accounts `accountId` blocks, as a subquery. */
export const blockedIdsQuery = (ctx: Context, accountId: string): AccountIdQuery =>
    ctx.db.selectFrom("blocks")
        .select("target_id as account_id")
        .where("account_id", "=", accountId);
