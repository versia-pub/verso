/**
 * Accounts as moderators see them through the admin API.
 * @see https://docs.joinmastodon.org/entities/Admin_Account/
 * @module
 */
import type { AdminAccount } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { type AccountRow, findAccounts } from "./account_queries.ts";
import { publicAccountsOf } from "./public.ts";
import { renderRole } from "./render.ts";
import { rolesOfAccounts } from "./role_queries.ts";

/**
 * `rows` as moderators see them, in the order given. A local user has the highest of their roles,
 * with what they may do from all of them and from `everyUser`. Verso doesn't keep what Mastodon
 * keeps of users' sign-ups, so those fields are empty.
 */
export const renderAdminAccountRows = async (
    ctx: Context,
    rows: readonly AccountRow[],
    everyUser: readonly Permission[],
): Promise<AdminAccount[]> => {
    const [accounts, roles] = await Promise.all([
        publicAccountsOf(ctx, rows),
        rolesOfAccounts(ctx, rows.filter((row) => row.domain === null).map((row) => row.id)),
    ]);

    return rows.map((row) => {
        const account = accounts.get(row.id);
        if (account === undefined) throw new Error(`Account ${row.id} wasn't rendered`);

        const local = row.domain === null;
        const held = roles.get(row.id) ?? [];

        return {
            id: row.id,
            username: row.username,
            domain: row.domain,
            created_at: row.created_at.toISOString(),
            email: null,
            ip: null,
            ips: [],
            locale: null,
            invite_request: null,
            role: local
                ? renderRole(held, [...everyUser, ...held.flatMap((role) => role.permissions)])
                : null,
            confirmed: local ? true : null,
            approved: local ? true : null,
            disabled: local ? false : null,
            silenced: row.silenced_at !== null,
            suspended: row.suspended_at !== null,
            sensitized: false,
            account,
        };
    });
};

/** The accounts in `ids` that exist, by id, as {@link renderAdminAccountRows} renders them. */
export const renderAdminAccounts = async (
    ctx: Context,
    ids: readonly string[],
    everyUser: readonly Permission[],
): Promise<Map<string, AdminAccount>> => {
    const rows = await findAccounts(ctx, [...new Set(ids)]);
    const accounts = await renderAdminAccountRows(ctx, rows, everyUser);

    return new Map(accounts.map((account) => [account.id, account]));
};
