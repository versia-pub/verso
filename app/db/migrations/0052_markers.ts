import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const markers: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("markers")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("timeline", "text", (column) => column.notNull())
            .addColumn("last_read_id", "text", (column) => column.notNull())
            .addColumn("version", "integer", (column) => column.notNull())
            .addColumn("updated_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("markers_pkey", ["account_id", "timeline"])
            .execute();
    },
};
