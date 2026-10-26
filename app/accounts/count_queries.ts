/**
 * The counts stored on accounts: who they follow, who follows them, and how many statuses they
 * posted.
 * @module
 */
import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Updates the counts of both accounts for a follow from `followerId` to `followeeId` that began
 * (`by` 1) or ended (`by` -1).
 */
export const countFollow = async (
    ctx: Context,
    followerId: string,
    followeeId: string,
    by: 1 | -1,
): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ following_count: eb("following_count", "+", by) }))
        .where("id", "=", followerId)
        .execute();

    await ctx.db.updateTable("accounts")
        .set((eb) => ({ followers_count: eb("followers_count", "+", by) }))
        .where("id", "=", followeeId)
        .execute();
};

/** Account ids, as a subquery from another module, such as those an account follows. */
export type AccountIds = SelectQueryBuilder<Database, keyof Database, { account_id: string }>;

/** Decrements the follower count of each of `accounts`, as when one of them is deleted. */
export const uncountFollowers = async (ctx: Context, accounts: AccountIds): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ followers_count: eb("followers_count", "-", 1) }))
        .where("id", "in", accounts)
        .execute();
};

/** Decrements the following count of each of `accounts`, as when one of them is deleted. */
export const uncountFollowing = async (ctx: Context, accounts: AccountIds): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ following_count: eb("following_count", "-", 1) }))
        .where("id", "in", accounts)
        .execute();
};

/**
 * Counts a status an account posted, or deleted, and when it last posted. An older status, such as
 * a remote one fetched late, doesn't move that back. Deleting a status leaves the time it last
 * posted unchanged, as Mastodon does.
 */
export const countNote = async (
    ctx: Context,
    accountId: string,
    by: 1 | -1,
    at: Date,
): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ statuses_count: eb("statuses_count", "+", by) }))
        .where("id", "=", accountId)
        .execute();
    if (by === -1) return;

    await ctx.db.updateTable("accounts")
        .set({ last_status_at: at })
        .where("id", "=", accountId)
        .where((eb) => eb.or([eb("last_status_at", "is", null), eb("last_status_at", "<", at)]))
        .execute();
};

/**
 * Decrements the status count of the account that each of `statuses` is by, such as other modules'
 * boosts of a status that is deleted, which are deleted with it.
 */
export const uncountStatusesFor = async (ctx: Context, statuses: AccountIds): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({
            statuses_count: eb(
                "statuses_count",
                "-",
                eb.selectFrom(statuses.as("uncounted"))
                    .select((count) => count.fn.countAll<number>().as("count"))
                    .whereRef("uncounted.account_id", "=", "accounts.id"),
            ),
        }))
        .where("id", "in", (eb) => eb.selectFrom(statuses.as("uncounted")).select("account_id"))
        .execute();
};
