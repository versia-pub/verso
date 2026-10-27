import type { Context } from "../kernel/context.ts";

/** The notifications of `accountId`, newest first, as their type, who did it, and the status. */
export const notificationsOf = async (
    ctx: Context,
    accountId: string,
): Promise<string[]> =>
    (await ctx.db.selectFrom("notifications").selectAll()
        .where("account_id", "=", accountId)
        .orderBy("id", "desc")
        .execute())
        .map((row) => [row.type, row.from_account_id, row.note_id ?? ""].join(" ").trim());

/** The group keys of `accountId`'s notifications, newest first, with `-` for none. */
export const groupKeysOf = async (ctx: Context, accountId: string): Promise<string[]> =>
    (await ctx.db.selectFrom("notifications").select("group_key")
        .where("account_id", "=", accountId)
        .orderBy("id", "desc")
        .execute())
        .map((row) => row.group_key ?? "-");
