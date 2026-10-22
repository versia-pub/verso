/**
 * Blocks: an account blocking another, so what the blocked account does doesn't reach it. Unlike
 * on Mastodon, a block is the blocker's alone, for their safety: the blocked account is never told,
 * nor can it tell, so it ends no follows, and nothing of it is sent to other instances. Only those
 * whose role lets them see everyone's blocks, such as moderators, see who blocks an account.
 * @see https://docs.joinmastodon.org/methods/accounts/#block
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import { blockedIdsQuery, deleteBlock, insertBlock } from "./block_queries.ts";
import { domainBlockedIdsQuery } from "./domain_block_queries.ts";
import type { AccountIdQuery } from "./follow_queries.ts";

/**
 * Has `accountId` block `targetId`. Returns whether there is such an account, other than the
 * blocker.
 */
export const block = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<boolean> => {
    if (targetId === accountId || await findAccount(ctx, targetId) === undefined) return false;

    await insertBlock(ctx, accountId, targetId);
    return true;
};

/** Has `accountId` stop blocking `targetId`. Returns whether it blocked them. */
export const unblock = (ctx: Context, accountId: string, targetId: string): Promise<boolean> =>
    deleteBlock(ctx, accountId, targetId);

/**
 * The accounts `accountId` blocks, itself or by their domain, as a subquery, for leaving what they
 * wrote and shared out of what reaches it.
 */
export const blockedSubquery = (ctx: Context, accountId: string): AccountIdQuery =>
    blockedIdsQuery(ctx, accountId).union(domainBlockedIdsQuery(ctx, accountId));

/** The accounts a viewer blocks, as {@link blockedSubquery} has them, or none without a viewer. */
export const viewerBlocks = (ctx: Context, viewerId: string | null): AccountIdQuery | null =>
    viewerId === null ? null : blockedSubquery(ctx, viewerId);
