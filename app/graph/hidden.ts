/**
 * What doesn't reach an account: the statuses and boosts of the accounts it blocks, individually or
 * by their domain, and of those it currently mutes, and their notifications.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { blockersAmong, blocksBetween } from "./block_queries.ts";
import { blockedByAccount } from "./blocks.ts";
import { domainBlockedAmong, domainBlockersAmong } from "./domain_block_queries.ts";
import type { Excluded } from "./excluded_queries.ts";
import { mutedIdsQuery, mutersAmong, mutesOf, notificationMutedIdsQuery } from "./mute_queries.ts";

/** The accounts `accountId` blocks, individually or by their domain, or currently mutes. */
export const hiddenFrom = (ctx: Context, accountId: string): Excluded => {
    const blocked = blockedByAccount(ctx, accountId);
    return { ...blocked, accounts: blocked.accounts.union(mutedIdsQuery(ctx, accountId)) };
};

/**
 * The accounts whose notifications don't reach `accountId`: those it blocks, individually or by
 * their domain, and those it currently mutes with their notifications, as on Mastodon.
 */
export const notificationsHiddenFrom = (ctx: Context, accountId: string): Excluded => {
    const blocked = blockedByAccount(ctx, accountId);
    return {
        ...blocked,
        accounts: blocked.accounts.union(notificationMutedIdsQuery(ctx, accountId)),
    };
};

/**
 * The accounts a viewer blocks or mutes, as {@link hiddenFrom} returns them, or none without a
 * viewer.
 */
export const viewerHidden = (ctx: Context, viewerId: string | null): Excluded | null =>
    viewerId === null ? null : hiddenFrom(ctx, viewerId);

/** Which of `otherIds` `accountId` blocks, individually or by their domain, or currently mutes. */
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

/** How many accounts {@link hidingAmong} asks about in each query, as queries take only so many. */
const askedAtOnce = 1000;

/**
 * Which of `otherIds` block `accountId`, individually or by its domain, or currently mute it, as
 * {@link hiddenFrom} finds for each of them. They are asked about 1000 at a time.
 */
export const hidingAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Set<string>> => {
    const hiding = new Set<string>();
    for (let start = 0; start < otherIds.length; start += askedAtOnce) {
        const asked = otherIds.slice(start, start + askedAtOnce);
        const found = [
            ...await blockersAmong(ctx, accountId, asked),
            ...await domainBlockersAmong(ctx, accountId, asked),
            ...await mutersAmong(ctx, accountId, asked),
        ];
        for (const id of found) hiding.add(id);
    }

    return hiding;
};
