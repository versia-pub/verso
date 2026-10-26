/**
 * The counts kept on accounts: who they follow, who follows them, and what they posted.
 * @module
 */
import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Counts a follow from `followerId` of `followeeId` that began, with `by` 1, or ended, with -1, in
 * both accounts' counts.
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

/** Accounts' ids, as a subquery of another module's, such as those an account follows. */
export type AccountIds = SelectQueryBuilder<Database, keyof Database, { account_id: string }>;

/** Takes one from the followers each of `accounts` has, as when one of them is deleted. */
export const uncountFollowers = async (ctx: Context, accounts: AccountIds): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ followers_count: eb("followers_count", "-", 1) }))
        .where("id", "in", accounts)
        .execute();
};

/** Takes one from the accounts each of `accounts` follows, as when one of them is deleted. */
export const uncountFollowing = async (ctx: Context, accounts: AccountIds): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ following_count: eb("following_count", "-", 1) }))
        .where("id", "in", accounts)
        .execute();
};

/**
 * Counts a note an account posted, or deleted, and when it last posted, which an older note, such
 * as one fetched late from another instance, doesn't move back. Deleting a note leaves when it
 * last posted as it was, as Mastodon does.
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
 * Takes one from the statuses of the account each of `statuses` is by, such as other modules'
 * shares of a note that is deleted, which go with it.
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
