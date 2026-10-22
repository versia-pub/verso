/**
 * What doesn't reach an account: the notes and shares of the accounts it blocks, and of those it
 * mutes for now.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { blockedIdsQuery, blocksBetween } from "./block_queries.ts";
import type { AccountIdQuery } from "./follow_queries.ts";
import { mutedIdsQuery, mutesOf } from "./mute_queries.ts";

/** The accounts `accountId` blocks or mutes for now, as a subquery. */
export const hiddenSubquery = (ctx: Context, accountId: string): AccountIdQuery =>
    blockedIdsQuery(ctx, accountId).union(mutedIdsQuery(ctx, accountId));

/** The accounts a viewer blocks or mutes, as {@link hiddenSubquery} has them, or none without one. */
export const viewerHidden = (ctx: Context, viewerId: string | null): AccountIdQuery | null =>
    viewerId === null ? null : hiddenSubquery(ctx, viewerId);

/** Which of `otherIds` `accountId` blocks or mutes for now. */
export const hiddenAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Set<string>> => {
    const { blocking } = await blocksBetween(ctx, accountId, otherIds);
    const muting = await mutesOf(ctx, accountId, otherIds);

    return new Set([...blocking, ...muting.keys()]);
};
