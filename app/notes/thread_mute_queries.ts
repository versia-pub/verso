import type { Context } from "../kernel/context.ts";

/** Mutes a thread for an account, unless it already is. */
export const insertThreadMute = async (
    ctx: Context,
    accountId: string,
    threadId: string,
): Promise<void> => {
    await ctx.db.insertInto("thread_mutes")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            thread_id: threadId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "thread_id"]).doNothing())
        .execute();
};

/** Unmutes a thread for an account. */
export const deleteThreadMute = async (
    ctx: Context,
    accountId: string,
    threadId: string,
): Promise<void> => {
    await ctx.db.deleteFrom("thread_mutes")
        .where("account_id", "=", accountId)
        .where("thread_id", "=", threadId)
        .execute();
};

/** Which of `threadIds` the account mutes. */
export const mutedThreadsAmong = async (
    ctx: Context,
    accountId: string,
    threadIds: readonly string[],
): Promise<Set<string>> => {
    if (threadIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("thread_mutes").select("thread_id")
        .where("account_id", "=", accountId)
        .where("thread_id", "in", [...new Set(threadIds)])
        .execute();
    return new Set(rows.map((row) => row.thread_id));
};

/** Which of `accountIds` mute the thread `threadId`. */
export const threadMutersAmong = async (
    ctx: Context,
    threadId: string,
    accountIds: readonly string[],
): Promise<Set<string>> => {
    if (accountIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("thread_mutes").select("account_id")
        .where("thread_id", "=", threadId)
        .where("account_id", "in", accountIds)
        .execute();
    return new Set(rows.map((row) => row.account_id));
};
