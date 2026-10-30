/**
 * Endorsements: the accounts that local users feature on their profiles, which Mastodon also calls
 * pinning them. Only followed accounts are featured, and unfollowing one stops featuring it. They
 * aren't federated.
 * @see https://docs.joinmastodon.org/methods/endorsements/
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import { deleteEndorsement, insertEndorsement } from "./endorsement_queries.ts";
import { isFollowing } from "./follows.ts";

/** The result of featuring an account. */
export type EndorseResult =
    /** The account is featured, now or already. */
    | "endorsed"
    /** There is no such account. */
    | "missing"
    /** The user doesn't follow the account. */
    | "unfollowed";

/** Has `accountId` feature `targetId` on their profile. */
export const endorse = (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<EndorseResult> =>
    ctx.transaction(async (tx) => {
        if (await findAccount(tx, targetId) === undefined) return "missing";
        if (!await isFollowing(tx, accountId, targetId)) return "unfollowed";

        await insertEndorsement(tx, accountId, targetId);
        return "endorsed";
    });

/** Has `accountId` stop featuring `targetId`. Returns whether there is such an account. */
export const unendorse = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<boolean> => {
    if (await findAccount(ctx, targetId) === undefined) return false;

    await deleteEndorsement(ctx, accountId, targetId);
    return true;
};
