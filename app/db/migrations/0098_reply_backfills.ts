import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** When Verso last fetched the replies of each remote status. */
export const replyBackfills: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("reply_backfills")
            .addColumn(
                "note_id",
                "text",
                (column) => column.primaryKey().references("notes.id").onDelete("cascade"),
            )
            .addColumn("fetched_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
