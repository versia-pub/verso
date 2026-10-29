import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { PushAlert, PushPolicy, PushSubscriptionsTable } from "./tables.ts";

export type PushSubscriptionRow = Selectable<PushSubscriptionsTable>;

/** The subscription of the token `tokenId`, if it has one. */
export const findSubscription = (
    ctx: Context,
    tokenId: string,
): Promise<PushSubscriptionRow | undefined> =>
    ctx.db.selectFrom("push_subscriptions").selectAll().where("token_id", "=", tokenId)
        .executeTakeFirst();

/** The subscriptions of the user `accountId`, one for each token they subscribed with. */
export const subscriptionsOf = (ctx: Context, accountId: string): Promise<PushSubscriptionRow[]> =>
    ctx.db.selectFrom("push_subscriptions").selectAll().where("account_id", "=", accountId)
        .execute();

/** The subscription `id`, if it still exists. */
export const findSubscriptionById = (
    ctx: Context,
    id: string,
): Promise<PushSubscriptionRow | undefined> =>
    ctx.db.selectFrom("push_subscriptions").selectAll().where("id", "=", id).executeTakeFirst();

/** Deletes the subscription `id`, such as when its push service says it has gone. */
export const deleteSubscriptionById = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("push_subscriptions").where("id", "=", id).execute();
};

/** Replaces the subscription of the row's token, if it has one, with the row. */
export const replaceSubscription = async (
    ctx: Context,
    row: PushSubscriptionsTable,
): Promise<void> => {
    await deleteSubscription(ctx, row.token_id);
    await ctx.db.insertInto("push_subscriptions").values(row).execute();
};

/**
 * Changes which notifications the subscription of `tokenId` pushes, returning it, if it has one.
 */
export const updateSubscription = (
    ctx: Context,
    tokenId: string,
    alerts: readonly PushAlert[],
    policy: PushPolicy,
): Promise<PushSubscriptionRow | undefined> =>
    ctx.db.updateTable("push_subscriptions")
        .set({ alerts: [...alerts], policy })
        .where("token_id", "=", tokenId)
        .returningAll()
        .executeTakeFirst();

/** Deletes the subscription of `tokenId`, if it has one. */
export const deleteSubscription = async (ctx: Context, tokenId: string): Promise<void> => {
    await ctx.db.deleteFrom("push_subscriptions").where("token_id", "=", tokenId).execute();
};
