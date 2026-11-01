import type { Report } from "@versia/client-api";
import { publicAccounts } from "../accounts/public.ts";
import type { Context } from "../kernel/context.ts";
import type { ReportRow } from "./report_queries.ts";

/** A report as Mastodon gives it to the user who filed it. */
export const renderReport = async (ctx: Context, row: ReportRow): Promise<Report> => {
    const [target] = await publicAccounts(ctx, [row.target_account_id]);
    if (target === undefined) throw new Error(`Account ${row.target_account_id} doesn't exist`);

    return {
        id: row.id,
        action_taken: row.resolved_at !== null,
        action_taken_at: row.resolved_at?.toISOString() ?? null,
        category: row.category,
        comment: row.comment,
        forwarded: row.forwarded,
        created_at: row.created_at.toISOString(),
        status_ids: row.note_ids,
        rule_ids: row.rule_ids,
        target_account: target,
    };
};
