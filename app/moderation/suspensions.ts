/**
 * Suspending accounts, local or remote, as whoever runs the instance does. A suspension keeps
 * everything, so it can be undone.
 * @module
 */
import { setSuspendedAt } from "../accounts/account_queries.ts";
import { endSessionsOf } from "../auth/tokens.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Suspends an account. A local user's tokens stop working and their streams close. Returns whether
 * it wasn't suspended already.
 */
export const suspend = (ctx: Context, accountId: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (!await setSuspendedAt(tx, accountId, tx.clock.now())) return false;

        await endSessionsOf(tx, accountId);
        return true;
    });

/** Lifts an account's suspension. Returns whether it was suspended. */
export const unsuspend = (ctx: Context, accountId: string): Promise<boolean> =>
    setSuspendedAt(ctx, accountId, null);
