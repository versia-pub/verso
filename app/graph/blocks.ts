/**
 * Blocks: an account blocking another, so what the blocked account does doesn't reach it. Unlike on
 * Mastodon, a block is the blocker's alone, for their safety: the blocked account is never
 * notified, nor can it tell, so it ends no follows, and nothing about it is sent to remote
 * instances. A blocked follower stops being shown the blocker's followers-only statuses, as if the
 * blocker had stopped posting them, unless a status mentions it. Only those whose role lets them see everyone's blocks, such as moderators, see who
 * blocks an account.
 * @see https://docs.joinmastodon.org/methods/accounts/#block
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import {
    blockedIdsQuery,
    blockerIdsQuery,
    blockersAmong,
    blockingAmong,
    deleteBlock,
    insertBlock,
} from "./block_queries.ts";
import { domainBlockedInstancesQuery, domainBlockingAmong } from "./domain_block_queries.ts";
import type { AccountIdQuery } from "./follow_queries.ts";
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
 * Which of `accountIds` block any of `targets`, individually or by their domain, so must have what
 * those did taken out of what they are shown.
 */
export const blockingAny = async (
    ctx: Context,
    accountIds: readonly string[],
    targets: AccountIdQuery,
): Promise<Set<string>> => {
    if (accountIds.length === 0) return new Set();

    return new Set([
        ...await blockingAmong(ctx, accountIds, targets),
        ...await domainBlockingAmong(ctx, accountIds, targets),
    ]);
};

/**
 * The accounts that block `accountId`, as a subquery, so that their followers-only statuses can be
 * kept from it.
 */
export const blockersSubquery = (ctx: Context, accountId: string): AccountIdQuery =>
    blockerIdsQuery(ctx, accountId);

/** Whether `blockerId` blocks `accountId`. */
export const isBlockedBy = async (
    ctx: Context,
    accountId: string,
    blockerId: string,
): Promise<boolean> => (await blockersAmong(ctx, accountId, [blockerId])).length > 0;

/**
 * The accounts a viewer blocks, as {@link blockedByAccount} returns them, or none without a viewer.
 */
export const viewerBlocks = (ctx: Context, viewerId: string | null): Excluded | null =>
    viewerId === null ? null : blockedByAccount(ctx, viewerId);
