import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { AccountsTable } from "./tables.ts";

/** An account, with the domain of its instance, or `null` for this one. */
export type AccountRow = Selectable<AccountsTable> & { readonly domain: string | null };

const accountRows = (ctx: Context) =>
    ctx.db.selectFrom("accounts")
        .leftJoin("instances", "instances.id", "accounts.instance_id")
        .selectAll("accounts")
        .select("instances.domain");

/** The account `id`, with its instance's domain, or `undefined` if there is none. */
export const findAccount = (ctx: Context, id: string): Promise<AccountRow | undefined> =>
    accountRows(ctx).where("accounts.id", "=", id).executeTakeFirst();

/** The local account named `username`, ignoring case, or `undefined` if there is none. */
export const findLocalAccount = (
    ctx: Context,
    username: string,
): Promise<AccountRow | undefined> =>
    accountRows(ctx)
        .where("accounts.instance_id", "is", null)
        .where((eb) => eb(eb.fn("lower", ["accounts.username"]), "=", username.toLowerCase()))
        .executeTakeFirst();

/** Which of `ids` are local accounts, in no particular order. */
export const localAccountIds = async (ctx: Context, ids: readonly string[]): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("accounts")
        .select("id")
        .where("id", "in", ids)
        .where("instance_id", "is", null)
        .execute();

    return rows.map((row) => row.id);
};

/** The username of an account, which must exist. */
export const getUsername = async (ctx: Context, accountId: string): Promise<string> => {
    const { username } = await ctx.db.selectFrom("accounts")
        .select("username")
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow();

    return username;
};

/** How many local accounts got an access token since `since`, as a measure of who is active. */
export const countActiveAccounts = async (ctx: Context, since: Date): Promise<number> => {
    const { count } = await ctx.db.selectFrom("accounts")
        .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
        .where("instance_id", "is", null)
        .where((eb) =>
            eb.exists(
                eb.selectFrom("access_tokens")
                    .select("id")
                    .whereRef("access_tokens.account_id", "=", "accounts.id")
                    .where("access_tokens.created_at", ">=", since),
            )
        )
        .executeTakeFirstOrThrow();

    return Number(count);
};

/** How many accounts this instance has. */
export const countLocalAccounts = async (ctx: Context): Promise<number> => {
    const { count } = await ctx.db.selectFrom("accounts")
        .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
        .where("instance_id", "is", null)
        .executeTakeFirstOrThrow();

    return Number(count);
};
