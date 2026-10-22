/**
 * Mutes: an account muting another, as on Mastodon, so what the muted account posts doesn't reach
 * it, for a while or for good. Like a block, a mute is the muter's alone: the muted account is never
 * told, and nothing of it is sent to other instances. Unlike a block, nobody else can see it.
 * @see https://docs.joinmastodon.org/methods/accounts/#mute
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import { deleteMute, upsertMute } from "./mute_queries.ts";

/** How an account mutes another, as Mastodon takes it. */
export type MuteRequest = {
    /** Whether the muted account's notifications are muted too. */
    readonly notifications: boolean;
    /** How many seconds the mute lasts, or 0 for good. */
    readonly duration: number;
};

/**
 * Has `accountId` mute `targetId`, or changes how it does. Returns whether there is such an
 * account, other than the muter.
 */
export const mute = async (
    ctx: Context,
    accountId: string,
    targetId: string,
    request: MuteRequest,
): Promise<boolean> => {
    if (targetId === accountId || await findAccount(ctx, targetId) === undefined) return false;

    const expiresAt = request.duration === 0
        ? null
        : new Date(ctx.clock.now().getTime() + request.duration * 1000);
    await upsertMute(ctx, accountId, targetId, {
        notifications: request.notifications,
        expiresAt,
    });
    return true;
};

/** Has `accountId` stop muting `targetId`. Returns whether it muted them. */
export const unmute = (ctx: Context, accountId: string, targetId: string): Promise<boolean> =>
    deleteMute(ctx, accountId, targetId);
