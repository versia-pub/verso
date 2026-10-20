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

/** The accounts of `ids` that exist, as anyone sees them, in the order of `ids`. */
export const publicAccounts = async (ctx: Context, ids: readonly string[]): Promise<Account[]> => {
    const rows = new Map((await findAccounts(ctx, ids)).map((row) => [row.id, row]));
    const roles = await rolesOfAccounts(ctx, [...rows.keys()]);

    return ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [renderAccount(ctx, row, roles.get(id) ?? [])] : [];
    });
};
