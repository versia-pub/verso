import type { Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { ReportsTable } from "./tables.ts";

export type ReportRow = Selectable<ReportsTable>;

export const insertReport = async (ctx: Context, row: ReportRow): Promise<void> => {
    await ctx.db.insertInto("reports").values(row).execute();
};

/** Saves a report from another instance, unless it was already received. */
export const insertReceivedReport = async (ctx: Context, row: ReportRow): Promise<void> => {
    await ctx.db.insertInto("reports").values(row)
        .onConflict((conflict) =>
            conflict.columns(["instance_id", "digest", "target_account_id"]).doNothing()
        )
        .execute();
};

export const findReport = (ctx: Context, id: string): Promise<ReportRow | undefined> =>
    ctx.db.selectFrom("reports").selectAll().where("id", "=", id).executeTakeFirst();

/** A report, with the domain of the instance that sent it, if one did. */
export type ListedReport = ReportRow & { readonly instance: string | null };

/** Every report, or only those no moderator has dealt with yet, the first filed first. */
export const listReports = (ctx: Context, unresolvedOnly: boolean): Promise<ListedReport[]> => {
    let query = ctx.db.selectFrom("reports")
        .leftJoin("instances", "instances.id", "reports.instance_id")
        .selectAll("reports")
        .select("instances.domain as instance")
        .orderBy("reports.id");
    if (unresolvedOnly) query = query.where("reports.resolved_at", "is", null);

    return query.execute();
};

/** Marks the report `id` as dealt with at `at`, unless it already is. Returns whether it exists. */
export const resolveReport = async (ctx: Context, id: string, at: Date): Promise<boolean> => {
    const report = await ctx.db.selectFrom("reports").select("resolved_at").where("id", "=", id)
        .executeTakeFirst();
    if (report === undefined) return false;

    if (report.resolved_at === null) {
        await ctx.db.updateTable("reports").set({ resolved_at: at }).where("id", "=", id).execute();
    }

    return true;
};

/** Which reports a moderator lists: by whether they are resolved, who filed them, and of whom. */
export type ReportFilter = {
    readonly state: "unresolved" | "resolved" | "all";
    readonly accountId?: string;
    readonly targetAccountId?: string;
};

/** A page of the reports that `filter` matches, the latest filed first. */
export const reportPage = (
    ctx: Context,
    filter: ReportFilter,
    page: PageBounds,
): Promise<ReportRow[]> => {
    let query = ctx.db.selectFrom("reports").selectAll();
    if (filter.state === "unresolved") query = query.where("resolved_at", "is", null);
    if (filter.state === "resolved") query = query.where("resolved_at", "is not", null);
    if (filter.accountId !== undefined) query = query.where("account_id", "=", filter.accountId);
    if (filter.targetAccountId !== undefined) {
        query = query.where("target_account_id", "=", filter.targetAccountId);
    }

    return readPage(query, "reports.id", page);
};

/**
 * Marks the report `id` as resolved at `at` by the moderator `by`, even if it already was, like
 * Mastodon's admin API. Returns the report, or `undefined` if it doesn't exist.
 */
export const resolveReportBy = (
    ctx: Context,
    id: string,
    by: string,
    at: Date,
): Promise<ReportRow | undefined> =>
    ctx.db.updateTable("reports")
        .set({ resolved_at: at, resolved_by_account_id: by, updated_at: at })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

/**
 * Marks the report `id` as unresolved, changing nothing if it already is. Returns the report, or
 * `undefined` if it doesn't exist.
 */
export const reopenReport = async (
    ctx: Context,
    id: string,
    at: Date,
): Promise<ReportRow | undefined> => {
    await ctx.db.updateTable("reports")
        .set({ resolved_at: null, resolved_by_account_id: null, updated_at: at })
        .where("id", "=", id)
        .where("resolved_at", "is not", null)
        .execute();

    return await findReport(ctx, id);
};

/** The ids of the reports about `targetId` that are unresolved. */
export const unresolvedReportIdsAbout = async (
    ctx: Context,
    targetId: string,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("reports").select("id")
        .where("target_account_id", "=", targetId)
        .where("resolved_at", "is", null)
        .execute();

    return rows.map((row) => row.id);
};

/** Marks the reports `ids` as resolved like {@link resolveReportBy} does. */
export const resolveReportsBy = async (
    ctx: Context,
    ids: readonly string[],
    by: string,
    at: Date,
): Promise<void> => {
    if (ids.length === 0) return;

    await ctx.db.updateTable("reports")
        .set({ resolved_at: at, resolved_by_account_id: by, updated_at: at })
        .where("id", "in", ids)
        .execute();
};
