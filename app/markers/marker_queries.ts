import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MarkersTable, Timeline } from "./tables.ts";

export type MarkerRow = Selectable<MarkersTable>;

/** The markers of `accountId` in those of `timelines` it has one in. */
export const markersOf = async (
    ctx: Context,
    accountId: string,
    timelines: readonly Timeline[],
): Promise<MarkerRow[]> => {
    if (timelines.length === 0) return [];

    return await ctx.db.selectFrom("markers").selectAll()
        .where("account_id", "=", accountId)
        .where("timeline", "in", timelines)
        .execute();
};

/** Marks that `accountId` read `timeline` up to `lastReadId`, a version on from before. */
export const setMarker = async (
    ctx: Context,
    accountId: string,
    timeline: Timeline,
    lastReadId: string,
): Promise<MarkerRow> => {
    const now = ctx.clock.now();

    return await ctx.db.insertInto("markers")
        .values({
            account_id: accountId,
            timeline,
            last_read_id: lastReadId,
            version: 1,
            updated_at: now,
        })
        .onConflict((conflict) =>
            conflict.columns(["account_id", "timeline"]).doUpdateSet((eb) => ({
                last_read_id: lastReadId,
                version: eb("markers.version", "+", 1),
                updated_at: now,
            }))
        )
        .returningAll()
        .executeTakeFirstOrThrow();
};
