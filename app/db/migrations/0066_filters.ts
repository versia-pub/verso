import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The filters that users make, and the keywords and statuses they match. */
export const filters: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("filters")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("title", "text", (column) => column.notNull())
            .addColumn("context", types.json, (column) => column.notNull())
            .addColumn("action", "text", (column) => column.notNull())
            .addColumn("expires_at", types.timestamp)
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("filters_by_account").on("filters")
            .columns(["account_id", "id"])
            .execute();

        await db.schema.createTable("filter_keywords")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "filter_id",
                "text",
                (column) => column.notNull().references("filters.id").onDelete("cascade"),
            )
            .addColumn("keyword", "text", (column) => column.notNull())
            .addColumn("whole_word", "boolean", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("filter_keywords_by_filter").on("filter_keywords")
            .columns(["filter_id", "id"])
            .execute();

        await db.schema.createTable("filter_statuses")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "filter_id",
                "text",
                (column) => column.notNull().references("filters.id").onDelete("cascade"),
            )
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("filter_statuses_by_pair").on("filter_statuses")
            .unique()
            .columns(["filter_id", "note_id"])
            .execute();

        // For removing them when their status is deleted.
        await db.schema.createIndex("filter_statuses_by_note").on("filter_statuses")
            .column("note_id")
            .execute();
    },
};
