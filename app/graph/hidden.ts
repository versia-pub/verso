/**
 * What doesn't reach an account: the notes and shares of the accounts it blocks, itself or by
 * their domain, and of those it mutes for now.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { blocksBetween } from "./block_queries.ts";
import { blockedByAccount } from "./blocks.ts";
import { domainBlockedAmong } from "./domain_block_queries.ts";
import type { Excluded } from "./excluded_queries.ts";
import { mutedIdsQuery, mutesOf } from "./mute_queries.ts";

/** The accounts `accountId` blocks, itself or by their domain, or mutes for now. */
export const hiddenFrom = (ctx: Context, accountId: string): Excluded => {
    const blocked = blockedByAccount(ctx, accountId);
    return { ...blocked, accounts: blocked.accounts.union(mutedIdsQuery(ctx, accountId)) };
};

/** The accounts a viewer blocks or mutes, as {@link hiddenFrom} has them, or none without one. */
export const viewerHidden = (ctx: Context, viewerId: string | null): Excluded | null =>
    viewerId === null ? null : hiddenFrom(ctx, viewerId);

/** Which of `otherIds` `accountId` blocks, itself or by their domain, or mutes for now. */
export const hiddenAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Set<string>> => {
    const { blocking } = await blocksBetween(ctx, accountId, otherIds);
    const domainBlocked = await domainBlockedAmong(ctx, accountId, otherIds);
    const muting = await mutesOf(ctx, accountId, otherIds);

    return new Set([...blocking, ...domainBlocked, ...muting.keys()]);
};
