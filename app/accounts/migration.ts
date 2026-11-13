/**
 * Local users moving, as Versia's migration extension has it: a user names the account it moved
 * from as its `previous`, which that account's instance checks before moving it here, and moves to
 * an account that names it, at most once a month.
 * @see https://versia.pub/extensions/migration
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/services/move_service.rb
 * @module
 */
import type { v0_6 } from "@versia/protocol";
import { formatReference } from "@versia/protocol";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type AccountRow, findAccount, updateLocalAccount } from "./account_queries.ts";
import type { AccountMoved, ProfileUpdated } from "./events.ts";
import { accountAt, referenceOf } from "./moves.ts";

/** Mastodon's limit on how soon after moving a local user can move again. */
const cooldownMs = 30 * 24 * 60 * 60_000;

/** Why a local user couldn't move to an account. */
export type MoveRefusal =
    /** The account doesn't say it moved from the user's. */
    | "not-previous"
    /** The account is suspended, deleted, or moved itself. */
    | "unavailable"
    /** The user already moved there. */
    | "moved-there"
    /** The user moved less than a month ago. */
    | "too-soon";

/** The account the local user `account` says it moved from, if Verso has it. */
export const previousOf = async (
    ctx: Context,
    account: AccountRow,
): Promise<AccountRow | undefined> => {
    const { previous_host: host, previous_id: id } = account;
    return host === null || id === null ? undefined : await accountAt(ctx, { host, id });
};

/**
 * Has the local user `accountId` say it moved from `previous`, or from no account if it is
 * `undefined`, and sends its profile to its followers' instances.
 */
export const setPrevious = async (
    ctx: Context,
    accountId: string,
    previous: AccountRow | undefined,
): Promise<void> => {
    const reference = previous && referenceOf(ctx, previous);

    await ctx.transaction(async (tx) => {
        await updateLocalAccount(tx, accountId, {
            previous_host: reference?.host ?? null,
            previous_id: reference?.id ?? null,
        });
        await profileUpdated(tx, accountId);
    });
};

/** Emits that the local user `accountId` changed its profile, so it is sent to other instances. */
const profileUpdated = async (ctx: Context, accountId: string) => {
    const updated: ProfileUpdated = {
        type: "accounts.profile_updated",
        accountId,
        unlocked: false,
    };
    await emit(ctx, updated);
};

/** Why the local user `from` may not move to `to`, fetched again just now, if it may not. */
const refusalOf = (ctx: Context, from: AccountRow, to: AccountRow): MoveRefusal | undefined => {
    const { host, id } = referenceOf(ctx, from);
    if (to.previous_host !== host || to.previous_id !== id) return "not-previous";
    if (to.suspended_at !== null || to.deleted_at !== null || to.moved_to_account_id !== null) {
        return "unavailable";
    }
    if (from.moved_to_account_id === to.id) return "moved-there";

    const now = ctx.clock.now().getTime();
    if (from.moved_at !== null && now - from.moved_at.getTime() < cooldownMs) return "too-soon";
};

/**
 * Moves the local user `accountId` to `to`, if `to` says it moved from it: its local followers
 * then follow `to`, and the instances of its followers and of `to` are sent a Migration, and its
 * profile, which says where it moved. `to` must have been fetched again just now, so that what it
 * says is current.
 */
export const moveTo = async (
    ctx: Context,
    accountId: string,
    to: AccountRow,
): Promise<MoveRefusal | undefined> =>
    await ctx.transaction(async (tx) => {
        const from = await findAccount(tx, accountId);
        if (from?.domain !== null) return "unavailable";

        const refusal = refusalOf(tx, from, to);
        if (refusal !== undefined) return refusal;

        await updateLocalAccount(tx, from.id, {
            moved_to_account_id: to.id,
            moved_at: tx.clock.now(),
        });

        const moved: AccountMoved = {
            type: "accounts.moved",
            accountId: from.id,
            movedToId: to.id,
        };
        await emit(tx, moved);
        await profileUpdated(tx, from.id);

        const migration: v0_6.Migration = {
            type: "pub.versia:migration/Migration",
            created_at: tx.clock.now().toISOString(),
            author: from.id,
            destination: formatReference(referenceOf(tx, to), tx.urls.domain),
        };
        await queueDeliveriesTo(tx, migration, {
            instanceIds: to.instance_id === null ? [] : [to.instance_id],
            followersOf: from.id,
        });
    });

/**
 * Has the local user `accountId` no longer say it moved, and sends its profile to the instances of
 * its followers. Those that moved its followers already keep them where they are, as Versia has no
 * way to undo a move. It can't move again until a month after it last did.
 */
export const cancelMove = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.transaction(async (tx) => {
        await updateLocalAccount(tx, accountId, { moved_to_account_id: null });
        await profileUpdated(tx, accountId);
    });
};
