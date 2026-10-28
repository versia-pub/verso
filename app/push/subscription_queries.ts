import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { PushPolicy, PushSubscriptionsTable } from "./tables.ts";

export type PushSubscriptionRow = Selectable<PushSubscriptionsTable>;

/** The subscription of the token `tokenId`, if it has one. */
export const findSubscription = (
    ctx: Context,
    tokenId: string,
): Promise<PushSubscriptionRow | undefined> =>
    ctx.db.selectFrom("push_subscriptions").selectAll().where("token_id", "=", tokenId)
        .executeTakeFirst();

/** Replaces the subscription of the row's token, if it has one, with the row. */
export const replaceSubscription = async (
    ctx: Context,
    row: PushSubscriptionsTable,
): Promise<void> => {
    await deleteSubscription(ctx, row.token_id);
    await ctx.db.insertInto("push_subscriptions").values(row).execute();
};

/** Changes which notifications the subscription of `tokenId` pushes, returning it, if it has one. */
export const updateSubscription = (
    ctx: Context,
    tokenId: string,
    alerts: readonly string[],
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
