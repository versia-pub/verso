import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const remoteNoteTotals: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("remote_note_totals")
            .addColumn(
                "note_id",
                "text",
                (column) => column.primaryKey().references("notes.id").onDelete("cascade"),
            )
            .addColumn("likes", "integer")
            .addColumn("shares", "integer")
            .addColumn("replies", "integer")
            .addColumn("fetched_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
