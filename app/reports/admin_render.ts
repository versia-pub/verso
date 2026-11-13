/**
 * Reports as moderators see them through the admin API.
 * @see https://docs.joinmastodon.org/methods/admin/reports/
 * @module
 */
import type { AdminReport, Rule } from "@versia/client-api";
import { renderAdminAccounts } from "../accounts/admin_render.ts";
import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import { findNotes } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import type { ReportRow } from "./report_queries.ts";

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
