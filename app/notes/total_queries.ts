import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { RemoteNoteTotalsTable } from "./tables.ts";

export type RemoteNoteTotals = Selectable<RemoteNoteTotalsTable>;

/** Stores the totals that a remote instance reports for its status, replacing the previous ones. */
export const saveTotals = async (
    ctx: Context,
    totals: RemoteNoteTotals,
): Promise<void> => {
    const { note_id: _, ...changes } = totals;
    await ctx.db.insertInto("remote_note_totals")
        .values(totals)
        .onConflict((conflict) => conflict.column("note_id").doUpdateSet(changes))
        .execute();
};

/** The totals Verso has for each of `noteIds`, grouped by status. */
export const totalsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, RemoteNoteTotals>> => {
    if (noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("remote_note_totals").selectAll()
        .where("note_id", "in", noteIds)
        .execute();

    return new Map(rows.map((row) => [row.note_id, row]));
};
