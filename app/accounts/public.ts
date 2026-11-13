/**
 * Accounts as anyone sees them in the client API, for any module that lists them.
 * @module
 */
import type { Account } from "@versia/client-api";
import { emojisOfAccounts } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import type { Context } from "../kernel/context.ts";
import { type AccountRow, findAccount, findAccounts } from "./account_queries.ts";
import { renderAccount } from "./render.ts";
import { rolesOf, rolesOfAccounts } from "./role_queries.ts";

/** Accounts that were already fetched, as anyone sees them, by id, moved to `movedTo`'s. */
const accountsOf = async (
    ctx: Context,
    rows: readonly AccountRow[],
    movedTo: ReadonlyMap<string, Account> = new Map(),
) => {
    const ids = rows.map((row) => row.id);
    const roles = await rolesOfAccounts(ctx, ids);
    const emojis = await emojisOfAccounts(ctx, ids);

    return new Map(rows.map((row) => [
        row.id,
        renderAccount(
            ctx,
            row,
            roles.get(row.id) ?? [],
            renderEmojis(ctx, emojis.get(row.id) ?? []),
            row.moved_to_account_id === null ? undefined : movedTo.get(row.moved_to_account_id),
        ),
    ]));
};

/**
 * Accounts that were already fetched, as anyone sees them, by id, with the accounts they moved to,
 * which don't show where they moved in turn.
 */
export const publicAccountsOf = async (
    ctx: Context,
    rows: readonly AccountRow[],
): Promise<Map<string, Account>> => {
    const movedIds = new Set(rows.flatMap((row) => row.moved_to_account_id ?? []));
    const movedTo = await accountsOf(ctx, await findAccounts(ctx, [...movedIds]));

    return await accountsOf(ctx, rows, movedTo);
};

/** An account as anyone sees it, with its roles and the custom emojis it uses. */
const shownAccount = async (ctx: Context, row: AccountRow, movedTo?: Account) => {
    const emojis = (await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? [];
    return renderAccount(ctx, row, await rolesOf(ctx, row.id), renderEmojis(ctx, emojis), movedTo);
};

/**
 * An account as anyone sees it, with its roles, the custom emojis it uses, and the account it moved
 * to, which doesn't show where it moved in turn.
 */
export const publicAccount = async (ctx: Context, row: AccountRow): Promise<Account> => {
    const moved = row.moved_to_account_id === null
        ? undefined
        : await findAccount(ctx, row.moved_to_account_id);

    return await shownAccount(ctx, row, moved && await shownAccount(ctx, moved));
};

/** The accounts of `ids` that exist, as anyone sees them, in the order of `ids`. */
export const publicAccounts = async (ctx: Context, ids: readonly string[]): Promise<Account[]> => {
    const accounts = await publicAccountsOf(ctx, await findAccounts(ctx, ids));

    return ids.flatMap((id) => accounts.get(id) ?? []);
};
