import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const accountNotes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("account_notes")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "target_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("comment", "text", (column) => column.notNull())
            .addColumn("updated_at", types.timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("account_notes_pkey", ["account_id", "target_id"])
            .execute();

        await db.schema.createIndex("account_notes_by_target").on("account_notes")
            .column("target_id")
            .execute();
    },
};
