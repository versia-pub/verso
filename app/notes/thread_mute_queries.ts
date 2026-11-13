import { setsBy } from "../db/grouping.ts";
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

/** Which of `threadIds` each of `accountIds` mutes, by account. */
export const mutedThreadsAmong = async (
    ctx: Context,
    accountIds: readonly string[],
    threadIds: readonly string[],
): Promise<Map<string, Set<string>>> => {
    if (accountIds.length === 0 || threadIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("thread_mutes").select(["account_id", "thread_id"])
        .where("account_id", "in", accountIds)
        .where("thread_id", "in", [...new Set(threadIds)])
        .execute();

    return setsBy(rows, (row) => row.account_id, (row) => row.thread_id);
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
