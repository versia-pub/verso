import type { Context } from "../kernel/context.ts";

/** Sets what an account notes about another, or, given nothing, removes it. */
export const setAccountNote = async (
    ctx: Context,
    accountId: string,
    targetId: string,
    comment: string,
): Promise<void> => {
    if (comment === "") {
        await ctx.db.deleteFrom("account_notes")
            .where("account_id", "=", accountId)
            .where("target_id", "=", targetId)
            .execute();
        return;
    }

    const now = ctx.clock.now();
    await ctx.db.insertInto("account_notes")
        .values({ account_id: accountId, target_id: targetId, comment, updated_at: now })
        .onConflict((conflict) =>
            conflict.columns(["account_id", "target_id"]).doUpdateSet({ comment, updated_at: now })
        )
        .execute();
};

/** What `accountId` notes about each of `otherIds` it notes anything about, by the other. */
export const accountNotesOn = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Map<string, string>> => {
    if (otherIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("account_notes")
        .select(["target_id", "comment"])
        .where("account_id", "=", accountId)
        .where("target_id", "in", otherIds)
        .execute();
    return new Map(rows.map((row) => [row.target_id, row.comment]));
};
