/**
 * Reports of accounts, and some of their statuses, by local users to the instance's moderators,
 * who deal with them through `verso admin reports`.
 * @see https://docs.joinmastodon.org/methods/reports/
 * @module
 */
import type { ReportCategory } from "@versia/client-api";
import { type AccountRow, findAccount, findAccounts } from "../accounts/account_queries.ts";
import { ValidationFailed } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { visibleNotes } from "../notes/visibility.ts";
import { insertReport, listReports, type ReportRow, resolveReport } from "./report_queries.ts";

/** A report, as a local user files it. */
export type NewReport = {
    readonly targetId: string;
    /** Statuses by the reported account that the reporter may see. */
    readonly noteIds: readonly string[];
    readonly comment: string;
    readonly category?: ReportCategory;
    /** The rules broken, by their ids in `/api/v1/instance/rules`. */
    readonly ruleIds: readonly string[];
};

/**
 * The category of a report and the rules it says were broken, as Mastodon decides: a report that
 * names rules is a `violation`, and a `violation` must name rules that exist, each once. There are
 * `rules` rules, with the ids 1 up to that.
 */
const categoryOf = (report: NewReport, rules: number) => {
    const category = report.ruleIds.length > 0 ? "violation" : report.category ?? "other";
    if (category !== "violation") return { category, ruleIds: null };

    const valid = new Set(
        report.ruleIds.filter((id) => /^[1-9]\d*$/.test(id) && Number(id) <= rules),
    );
    if (valid.size === 0 || valid.size !== report.ruleIds.length) {
        throw new ValidationFailed({ rule_ids: ["does not reference valid rules"] });
    }

    return { category, ruleIds: [...report.ruleIds] };
};

/**
 * Files a report by `accountId`, a local user, of an account and some of its statuses, to the
 * instance's moderators, with `rules` rules to say were broken. Returns `undefined` if the account
 * doesn't exist, or one of the statuses isn't the account's or `accountId` may not see it.
 */
export const fileReport = async (
    ctx: Context,
    accountId: string,
    report: NewReport,
    rules: number,
): Promise<ReportRow | undefined> => {
    const { category, ruleIds } = categoryOf(report, rules);
    if (await findAccount(ctx, report.targetId) === undefined) return undefined;

    const noteIds = [...new Set(report.noteIds)];
    const notes = await visibleNotes(ctx, noteIds, accountId);
    if (
        notes.length !== noteIds.length ||
        notes.some((note) => note.account_id !== report.targetId)
    ) {
        return undefined;
    }

    const row: ReportRow = {
        id: ctx.ids(),
        account_id: accountId,
        target_account_id: report.targetId,
        category,
        comment: report.comment,
        note_ids: noteIds,
        rule_ids: ruleIds,
        // Until reports are sent to other instances.
        forwarded: false,
        created_at: ctx.clock.now(),
        resolved_at: null,
    };
    await insertReport(ctx, row);
    return row;
};

/** An account's handle, `username` for a local one and `username@domain` for a remote one. */
const acctOf = (account: AccountRow | undefined) =>
    account &&
    (account.domain === null ? account.username : `${account.username}@${account.domain}`);

/** A report, as `verso admin reports list` prints it, with the accounts in it by id. */
const adminView = (report: ReportRow, accounts: ReadonlyMap<string, AccountRow>) => ({
    id: report.id,
    created_at: report.created_at.toISOString(),
    reporter: acctOf(accounts.get(report.account_id ?? "")) ?? null,
    target: acctOf(accounts.get(report.target_account_id)),
    category: report.category,
    comment: report.comment,
    status_ids: report.note_ids,
    rule_ids: report.rule_ids,
    forwarded: report.forwarded,
    resolved_at: report.resolved_at?.toISOString() ?? null,
});

/** The reports no moderator has dealt with yet, or with `all`, every report, the first first. */
export const reportsForAdmin = async (
    ctx: Context,
    all: boolean,
): Promise<ReturnType<typeof adminView>[]> => {
    const reports = await listReports(ctx, !all);
    const ids = reports.flatMap((report) => [report.account_id, report.target_account_id]);
    const accounts = new Map(
        (await findAccounts(ctx, [...new Set(ids)].filter((id) => id !== null))).map((row) => [
            row.id,
            row,
        ]),
    );

    return reports.map((report) => adminView(report, accounts));
};

/** Marks the report `id` as dealt with, unless it already is, and returns whether it exists. */
export const resolve = (ctx: Context, id: string): Promise<boolean> =>
    resolveReport(ctx, id, ctx.clock.now());
