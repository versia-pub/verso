/**
 * Silencing accounts, local or remote, for admins and moderators. Mastodon calls it "limit". A
 * silenced account's statuses stay out of the public timelines, and its notifications to those
 * who don't follow it go through their policy for limited accounts.
 * @module
 */
import { setSilencedAt } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";

/** Silences an account. Returns whether it wasn't silenced already. */
export const silence = (ctx: Context, accountId: string): Promise<boolean> =>
    setSilencedAt(ctx, accountId, ctx.clock.now());

/** Lifts an account's silence. Returns whether it was silenced. */
export const unsilence = (ctx: Context, accountId: string): Promise<boolean> =>
    setSilencedAt(ctx, accountId, null);
