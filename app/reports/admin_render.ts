/**
 * Reports, and the accounts in them, as moderators see them through the admin API.
 * @see https://docs.joinmastodon.org/methods/admin/reports/
 * @module
 */
import type { AdminAccount, AdminReport, Rule } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccountsOf } from "../accounts/public.ts";
import { renderRole } from "../accounts/render.ts";
import type { RoleRow } from "../accounts/role_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { findNotes } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import type { ReportRow } from "./report_queries.ts";

/** Each account's roles, highest priority first. */
const rolesOfAccounts = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, RoleRow[]>> => {
    const rows = ids.length === 0 ? [] : await ctx.db.selectFrom("account_roles")
        .innerJoin("roles", "roles.id", "account_roles.role_id")
        .selectAll("roles")
        .select("account_roles.account_id")
        .where("account_roles.account_id", "in", ids)
        .orderBy("roles.priority", "desc")
        .orderBy("roles.name")
        .execute();

    const roles = new Map<string, RoleRow[]>();
    for (const { account_id, ...role } of rows) {
        roles.set(account_id, [...roles.get(account_id) ?? [], role]);
    }
    return roles;
};

/**
 * The accounts in `ids` that exist, by id, as moderators see them. A local user has the highest of
 * their roles, with what they may do from all of them and from `everyUser`. Verso doesn't keep what
 * Mastodon keeps of users' sign-ups, so those fields are empty.
 */
export const renderAdminAccounts = async (
    ctx: Context,
    ids: readonly string[],
    everyUser: readonly Permission[],
): Promise<Map<string, AdminAccount>> => {
    const rows = await findAccounts(ctx, [...new Set(ids)]);
    const [accounts, roles] = await Promise.all([
        publicAccountsOf(ctx, rows),
        rolesOfAccounts(ctx, rows.filter((row) => row.domain === null).map((row) => row.id)),
    ]);

    return new Map(rows.flatMap((row) => {
        const account = accounts.get(row.id);
        if (account === undefined) return [];

        const local = row.domain === null;
        const held = roles.get(row.id) ?? [];
        const admin: AdminAccount = {
            id: row.id,
            username: row.username,
            domain: row.domain,
            created_at: row.created_at.toISOString(),
            email: null,
            ip: null,
            ips: [],
            locale: null,
            invite_request: null,
            role: local
                ? renderRole(held, [...everyUser, ...held.flatMap((role) => role.permissions)])
                : null,
            confirmed: local ? true : null,
            approved: local ? true : null,
            disabled: local ? false : null,
            silenced: row.silenced_at !== null,
            suspended: row.suspended_at !== null,
            sensitized: false,
            account,
        };
        return [[row.id, admin]];
    }));
};

/**
 * Reports as `viewerId`, a moderator, sees them, in the order given, with the rules they say were
 * broken, from `rules`, and the statuses they name that still exist.
 */
export const renderAdminReports = async (
    ctx: Context,
    reports: readonly ReportRow[],
    viewerId: string,
    rules: readonly Rule[],
    everyUser: readonly Permission[],
): Promise<AdminReport[]> => {
    const accountIds = reports.flatMap((report) =>
        [report.account_id, report.target_account_id, report.resolved_by_account_id]
            .filter((id) => id !== null)
    );
    const [accounts, notes] = await Promise.all([
        renderAdminAccounts(ctx, accountIds, everyUser),
        findNotes(ctx, [...new Set(reports.flatMap((report) => report.note_ids))]),
    ]);
    const statuses = new Map(
        (await renderStatuses(ctx, notes, viewerId)).map((status) => [status.id, status]),
    );
    const accountOf = (id: string | null) => (id === null ? undefined : accounts.get(id)) ?? null;

    return reports.map((report) => {
        const target = accounts.get(report.target_account_id);
        if (target === undefined) throw new Error(`Account ${report.target_account_id} is missing`);

        return {
            id: report.id,
            action_taken: report.resolved_at !== null,
            action_taken_at: report.resolved_at?.toISOString() ?? null,
            category: report.category,
            comment: report.comment,
            forwarded: report.forwarded,
            created_at: report.created_at.toISOString(),
            updated_at: (report.updated_at ?? report.created_at).toISOString(),
            account: accountOf(report.account_id),
            target_account: target,
            assigned_account: null,
            action_taken_by_account: accountOf(report.resolved_by_account_id),
            statuses: report.note_ids.flatMap((id) => statuses.get(id) ?? []),
            rules: rules.filter((rule) => report.rule_ids?.includes(rule.id) ?? false),
        };
    });
};
