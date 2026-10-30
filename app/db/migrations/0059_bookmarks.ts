import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const bookmarks: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("bookmarks")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("bookmarks_by_pair").on("bookmarks")
            .unique()
            .columns(["account_id", "note_id"])
            .execute();

        await db.schema.createIndex("bookmarks_by_note").on("bookmarks")
            .column("note_id")
            .execute();
    },
};
