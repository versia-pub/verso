/**
 * Local users moving from another account, as Versia's migration extension has it: a user names
 * the account it moved from as its `previous`, which that account's instance checks before moving
 * it here.
 * @see https://versia.pub/extensions/migration
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type AccountRow, updateLocalAccount } from "./account_queries.ts";
import type { ProfileUpdated } from "./events.ts";
import { accountAt, referenceOf } from "./moves.ts";

/** The account the local user `account` says it moved from, if Verso has it. */
export const previousOf = async (
    ctx: Context,
    account: AccountRow,
): Promise<AccountRow | undefined> => {
    const { previous_host: host, previous_id: id } = account;
    return host === null || id === null ? undefined : await accountAt(ctx, { host, id });
};

/**
 * Has the local user `accountId` say it moved from `previous`, or from no account if it is
 * `undefined`, and sends its profile to its followers' instances.
 */
export const setPrevious = async (
    ctx: Context,
    accountId: string,
    previous: AccountRow | undefined,
): Promise<void> => {
    const reference = previous && referenceOf(ctx, previous);

    await ctx.transaction(async (tx) => {
        await updateLocalAccount(tx, accountId, {
            previous_host: reference?.host ?? null,
            previous_id: reference?.id ?? null,
        });

        const updated: ProfileUpdated = {
            type: "accounts.profile_updated",
            accountId,
            unlocked: false,
        };
        await emit(tx, updated);
    });
};
