import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** What notes said before they were edited, for their edit history. */
export const noteVersions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("note_versions")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("content_html", "text", (column) => column.notNull())
            .addColumn("spoiler_text", "text", (column) => column.notNull())
            .addColumn("sensitive", "boolean", (column) => column.notNull())
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("note_versions_by_note").on("note_versions")
            .columns(["note_id", "id"])
            .execute();
    },
};
