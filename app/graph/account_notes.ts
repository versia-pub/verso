/**
 * Account notes: what an account privately notes about another account, which only it sees, and
 * which is never sent anywhere, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/accounts/#note
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import { setAccountNote } from "./account_note_queries.ts";

/** The longest an account note may be, in code points, as on Mastodon. */
export const accountNoteLimit = 2000;

/**
 * Sets what `accountId` notes about `targetId`, or clears it if `comment` is empty. Returns whether
 * there is such an account.
 */
export const noteAccount = async (
    ctx: Context,
    accountId: string,
    targetId: string,
    comment: string,
): Promise<boolean> => {
    if (await findAccount(ctx, targetId) === undefined) return false;

    await setAccountNote(ctx, accountId, targetId, comment);
    return true;
};
