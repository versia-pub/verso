import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { NotificationPoliciesTable } from "./tables.ts";

/** What a policy does with each kind of notification. */
export type Policy = Omit<Selectable<NotificationPoliciesTable>, "account_id" | "updated_at">;

/** The policy of users who haven't changed theirs, as on Mastodon. */
export const defaultPolicy: Policy = {
    for_not_following: "accept",
    for_not_followers: "accept",
    for_new_accounts: "accept",
    for_private_mentions: "filter",
    for_limited_accounts: "filter",
};

/** The most requests, and filtered mentions in each, that are counted, as on Mastodon. */
export const countedAtMost = 100;

/** The policies of `accountIds`, local users, with the defaults for those who have none. */
export const policiesOf = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<Map<string, Policy>> => {
    const rows = accountIds.length === 0 ? [] : await ctx.db.selectFrom("notification_policies")
        .selectAll()
        .where("account_id", "in", accountIds)
        .execute();
    const found = new Map(rows.map(({ account_id, updated_at: _, ...policy }) => [
        account_id,
        policy,
    ]));

    return new Map(accountIds.map((id) => [id, found.get(id) ?? defaultPolicy]));
};

/** Sets `accountId`'s policy to `policy`. */
export const savePolicy = async (
    ctx: Context,
    accountId: string,
    policy: Policy,
): Promise<void> => {
    const row = { ...policy, updated_at: ctx.clock.now() };

    await ctx.db.insertInto("notification_policies")
        .values({ account_id: accountId, ...row })
        .onConflict((conflict) => conflict.column("account_id").doUpdateSet(row))
        .execute();
};

/**
 * Keeps the request of `fromId`'s filtered mentions of `accountId`, making it if there is none,
 * with `noteId` as its latest status and its mentions counted again.
 */
export const saveRequest = async (
    ctx: Context,
    accountId: string,
    fromId: string,
    noteId: string,
): Promise<void> => {
    const { count } = await ctx.db.selectFrom(
        ctx.db.selectFrom("notifications").select("id")
            .where("account_id", "=", accountId)
            .where("from_account_id", "=", fromId)
            .where("type", "=", "mention")
            .where("filtered", "=", true)
            .limit(countedAtMost)
            .as("counted"),
    )
        .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
        .executeTakeFirstOrThrow();

    const now = ctx.clock.now();
    const changes = { last_note_id: noteId, notifications_count: Number(count), updated_at: now };

    await ctx.db.insertInto("notification_requests")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            from_account_id: fromId,
            ...changes,
            created_at: now,
        })
        .onConflict((conflict) =>
            conflict.columns(["account_id", "from_account_id"]).doUpdateSet(changes)
        )
        .execute();
};

/**
 * How many requests `accountId` has, and how many filtered mentions in them, counting up to 100
 * requests, as on Mastodon.
 */
export const requestSummaryOf = async (
    ctx: Context,
    accountId: string,
): Promise<{ readonly requests: number; readonly notifications: number }> => {
    const rows = await ctx.db.selectFrom("notification_requests")
        .select("notifications_count")
        .where("account_id", "=", accountId)
        .orderBy("id", "desc")
        .limit(countedAtMost)
        .execute();

    return {
        requests: rows.length,
        notifications: rows.reduce((sum, row) => sum + row.notifications_count, 0),
    };
};
