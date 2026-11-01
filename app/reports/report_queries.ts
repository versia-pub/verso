import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { ReportsTable } from "./tables.ts";

export type ReportRow = Selectable<ReportsTable>;

export const insertReport = async (ctx: Context, row: ReportRow): Promise<void> => {
    await ctx.db.insertInto("reports").values(row).execute();
};

/** Every report, or only those no moderator has dealt with yet, the first filed first. */
export const listReports = (ctx: Context, unresolvedOnly: boolean): Promise<ReportRow[]> => {
    let query = ctx.db.selectFrom("reports").selectAll().orderBy("id");
    if (unresolvedOnly) query = query.where("resolved_at", "is", null);

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
