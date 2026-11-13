/**
 * Lists of accounts that local users make. A list holds the owner and the accounts the owner
 * follows or has requested to follow. Unfollowing an account removes it from the owner's lists.
 * Lists aren't federated.
 * @see https://docs.joinmastodon.org/methods/lists/
 * @module
 */
import { existingAccountIds } from "../accounts/account_queries.ts";
import { followsFrom } from "../graph/follow_queries.ts";
import type { Context } from "../kernel/context.ts";
import {
    countLists,
    deleteListAccounts,
    findList,
    insertList,
    insertListAccount,
    listAccountsAmong,
    type ListChanges,
    type ListRow,
} from "./list_queries.ts";

/** Mastodon's limit on how many lists a user may have. */
export const listLimit = 50;

/** Makes a list for `accountId`, or returns `"full"` if they have as many as they may. */
export const createList = (
    ctx: Context,
    accountId: string,
    list: Required<ListChanges>,
): Promise<ListRow | "full"> =>
    ctx.transaction(async (tx) => {
        if (await countLists(tx, accountId) >= listLimit) return "full";

        return await insertList(tx, accountId, list);
    });

/** The result of adding accounts to a list. */
export type AddResult =
    /** They were all added. */
    | "added"
    /** The user has no such list. */
    | "no_list"
    /** One of them isn't an account. */
    | "missing"
    /** The user neither follows nor has requested to follow one of them. */
    | "unfollowed"
    /** One of them is in the list already. */
    | "taken";

/**
 * Adds `accountIds` to `accountId`'s list `listId`. If any can't be added, none are, as on
 * Mastodon.
 */
export const addListAccounts = (
    ctx: Context,
    accountId: string,
    listId: string,
    accountIds: readonly string[],
): Promise<AddResult> =>
    ctx.transaction(async (tx) => {
        if (await findList(tx, accountId, listId) === undefined) return "no_list";
        if ((await existingAccountIds(tx, accountIds)).length < accountIds.length) return "missing";

        const others = accountIds.filter((id) => id !== accountId);
        const rows = await followsFrom(tx, accountId, others);
        const follows = new Map(rows.map((follow) => [follow.followee_id, follow.id]));

        if (others.some((id) => !follows.has(id))) return "unfollowed";
        if ((await listAccountsAmong(tx, listId, accountIds)).size > 0) return "taken";

        for (const id of accountIds) {
            await insertListAccount(tx, listId, {
                accountId: id,
                followId: follows.get(id) ?? null,
            });
        }

        return "added";
    });

/**
 * Removes those of `accountIds` that are in `accountId`'s list `listId`. Returns whether the user
 * has that list.
 */
export const removeListAccounts = (
    ctx: Context,
    accountId: string,
    listId: string,
    accountIds: readonly string[],
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (await findList(tx, accountId, listId) === undefined) return false;

        await deleteListAccounts(tx, listId, accountIds);

        return true;
    });
