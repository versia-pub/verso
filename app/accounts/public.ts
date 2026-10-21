/**
 * Accounts as anyone sees them in the client API, for any module that lists them.
 * @module
 */
import type { Account } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccounts } from "./accounts.ts";
import { renderAccount } from "./render.ts";
import { rolesOf, rolesOfAccounts } from "./role_queries.ts";

/** An account as anyone sees it, with its roles. */
export const publicAccount = async (ctx: Context, row: AccountRow): Promise<Account> =>
    renderAccount(ctx, row, await rolesOf(ctx, row.id));

/** Accounts already read, as anyone sees them, by id. */
export const publicAccountsOf = async (
    ctx: Context,
    rows: readonly AccountRow[],
): Promise<Map<string, Account>> => {
    const roles = await rolesOfAccounts(ctx, rows.map((row) => row.id));
    return new Map(rows.map((row) => [row.id, renderAccount(ctx, row, roles.get(row.id) ?? [])]));
};

/** The accounts of `ids` that exist, as anyone sees them, in the order of `ids`. */
export const publicAccounts = async (ctx: Context, ids: readonly string[]): Promise<Account[]> => {
    const accounts = await publicAccountsOf(ctx, await findAccounts(ctx, ids));
    return ids.flatMap((id) => accounts.get(id) ?? []);
};
