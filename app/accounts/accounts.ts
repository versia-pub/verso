import { type Selectable, sql, type Updateable } from "kysely";
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

/**
 * The usernames of local accounts that start with `start`, ignoring case, in lowercase. In `like`,
 * `_` matches any character, so a few more may be found.
 */
export const localUsernamesStartingWith = async (
    ctx: Context,
    start: string,
): Promise<Set<string>> => {
    const rows = await ctx.db.selectFrom("accounts")
        .select("username")
        .where("instance_id", "is", null)
        .where(sql<string>`lower(username)`, "like", `${start.toLowerCase()}%`)
        .execute();

    return new Set(rows.map((row) => row.username.toLowerCase()));
};

/** Creates a local account. Returns whether it did, which it doesn't if the username is taken. */
export const insertLocalAccount = async (
    ctx: Context,
    account: { readonly id: string; readonly username: string; readonly displayName: string },
): Promise<boolean> => {
    const inserted = await ctx.db.insertInto("accounts")
        .values({
            id: account.id,
            username: account.username,
            instance_id: null,
            remote_id: null,
            created_at: ctx.clock.now(),
            display_name: account.displayName,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();

    return inserted !== undefined;
};

/** Deletes an account. */
export const deleteAccount = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("accounts").where("id", "=", id).execute();
};

/** Columns of an account to change. */
export type AccountChanges = Updateable<AccountsTable>;

/** Changes a local account. Columns left out, or set to `undefined`, stay as they are. */
export const updateLocalAccount = async (
    ctx: Context,
    id: string,
    changes: AccountChanges,
): Promise<void> => {
    // Kysely leaves out the columns set to `undefined`, and an update must set something.
    if (Object.values(changes).every((value) => value === undefined)) return;

    await ctx.db.updateTable("accounts")
        .set(changes)
        .where("id", "=", id)
        .where("instance_id", "is", null)
        .execute();
};

/** The account a login at `issuer` as `subject` is linked to, if any. */
export const linkedAccount = async (
    ctx: Context,
    issuer: string,
    subject: string,
): Promise<string | undefined> => {
    const row = await ctx.db.selectFrom("identities")
        .select("account_id")
        .where("issuer", "=", issuer)
        .where("subject", "=", subject)
        .executeTakeFirst();

    return row?.account_id;
};

/** Links a login to an account. Returns whether it did, which it doesn't if it was linked already. */
export const linkIdentity = async (
    ctx: Context,
    identity: { readonly issuer: string; readonly subject: string; readonly accountId: string },
): Promise<boolean> => {
    const linked = await ctx.db.insertInto("identities")
        .values({
            issuer: identity.issuer,
            subject: identity.subject,
            account_id: identity.accountId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("account_id")
        .executeTakeFirst();

    return linked !== undefined;
};
