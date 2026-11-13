/**
 * Moderating accounts through the admin API, as moderators with the `accounts` permission do. A
 * moderator may only act on remote accounts and on local users below their own highest role.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/models/admin/account_action.rb
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/policies/account_policy.rb
 * @module
 */
import { type AccountRow, findAccount } from "../accounts/account_queries.ts";
import { rolesOf } from "../accounts/role_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import {
    findReport,
    resolveReportsBy,
    unresolvedReportIdsAbout,
} from "../reports/report_queries.ts";
import { queueAccountDeletion } from "./account_deletions.ts";
import { silence } from "./silences.ts";
import { suspend } from "./suspensions.ts";

/** The moderator acting, with what they may do. */
export type Moderator = {
    readonly accountId: string;
    readonly permissions: ReadonlySet<Permission>;
};

/** What a moderator may do to an account. */
export type AccountActionType = "silence" | "suspend";

/** The outcome of a moderator's action, or why it was refused. */
export type Moderated =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: "not-found" }
    | { readonly ok: false; readonly reason: "not-permitted"; readonly description: string };

const refused = (description: string): Moderated => ({
    ok: false,
    reason: "not-permitted",
    description,
});

/** The priority of the highest role `accountId` has, or `-Infinity` without one. */
const highestRole = async (ctx: Context, accountId: string): Promise<number> =>
    (await rolesOf(ctx, accountId))[0]?.priority ?? -Infinity;

/**
 * Whether `moderator` outranks `target`: a remote account always, and a local user only if the
 * moderator's highest role is above theirs, as Mastodon's `UserRole#overrides?`. So no one outranks
 * themselves.
 */
const outranks = async (ctx: Context, moderator: Moderator, target: AccountRow) =>
    target.domain !== null ||
    await highestRole(ctx, moderator.accountId) > await highestRole(ctx, target.id);

/**
 * Silences or suspends the account `targetId`, and resolves every unresolved report about it, which
 * needs the `reports` permission when there are any. `reportId`, if given, must be a report.
 */
export const actOnAccount = async (
    ctx: Context,
    moderator: Moderator,
    targetId: string,
    action: { readonly type: AccountActionType; readonly reportId?: string },
): Promise<Moderated> => {
    const target = await findAccount(ctx, targetId);
    if (target === undefined) return { ok: false, reason: "not-found" };

    if (action.reportId !== undefined && await findReport(ctx, action.reportId) === undefined) {
        return { ok: false, reason: "not-found" };
    }

    if (!await outranks(ctx, moderator, target)) {
        return refused("You can only moderate accounts below your highest role");
    }

    const reportIds = await unresolvedReportIdsAbout(ctx, target.id);
    if (reportIds.length > 0 && !moderator.permissions.has("reports")) {
        return refused("Resolving the account's reports needs the reports permission");
    }

    await ctx.transaction(async (tx) => {
        if (action.type === "silence") await silence(tx, target.id);
        if (action.type === "suspend") await suspend(tx, target.id);
        await resolveReportsBy(tx, reportIds, moderator.accountId, tx.clock.now());
    });

    return { ok: true };
};

/**
 * Queues the deletion of `targetId`, a suspended local user below the moderator's highest role,
 * keeping a tombstone.
 */
export const queueModeratedDeletion = async (
    ctx: Context,
    moderator: Moderator,
    targetId: string,
): Promise<Moderated> => {
    const target = await findAccount(ctx, targetId);
    if (target === undefined) return { ok: false, reason: "not-found" };

    if (target.domain !== null) return refused("Remote accounts can't be deleted");
    if (target.suspended_at === null) return refused("Only suspended accounts can be deleted");
    if (!await outranks(ctx, moderator, target)) {
        return refused("You can only moderate accounts below your highest role");
    }

    await queueAccountDeletion(ctx, target.id);
    return { ok: true };
};
