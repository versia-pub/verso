/**
 * Blocks: an account blocking another, so what the blocked account does doesn't reach it. Unlike on
 * Mastodon, a block is the blocker's alone, for their safety: the blocked account is never
 * notified, nor can it tell, so it ends no follows, and nothing about it is sent to remote
 * instances. Only those whose role lets them see everyone's blocks, such as moderators, see who
 * blocks an account.
 * @see https://docs.joinmastodon.org/methods/accounts/#block
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import { blockedIdsQuery, deleteBlock, insertBlock } from "./block_queries.ts";
import { domainBlockedInstancesQuery } from "./domain_block_queries.ts";
import { type Excluded, excluded } from "./excluded_queries.ts";

export { type Excluded, isExcluded, notExcluded } from "./excluded_queries.ts";

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

/** Has `accountId` unblock `targetId`. Returns whether it blocked them. */
export const unblock = (ctx: Context, accountId: string, targetId: string): Promise<boolean> =>
    deleteBlock(ctx, accountId, targetId);

/**
 * The accounts `accountId` blocks, individually or by their domain, for omitting what they wrote
 * and boosted from what reaches it.
 */
export const blockedByAccount = (ctx: Context, accountId: string): Excluded =>
    excluded(ctx, blockedIdsQuery(ctx, accountId), domainBlockedInstancesQuery(ctx, accountId));

/**
 * The accounts a viewer blocks, as {@link blockedByAccount} returns them, or none without a viewer.
 */
export const viewerBlocks = (ctx: Context, viewerId: string | null): Excluded | null =>
    viewerId === null ? null : blockedByAccount(ctx, viewerId);
