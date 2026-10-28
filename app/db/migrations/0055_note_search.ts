import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { usesSqlite } from "../columns.ts";

/**
 * The words of each status, for searching them: a tsvector with a GIN index on Postgres, and an
 * FTS5 table on SQLite. Verso splits and folds the words itself, so both find the same statuses.
 */
export const noteSearch: Migration = {
    up: async (db: Kysely<unknown>) => {
        if (!usesSqlite(db)) {
            await db.schema.createTable("note_search")
                .addColumn(
                    "note_id",
                    "text",
                    (column) => column.primaryKey().references("notes.id").onDelete("cascade"),
                )
                .addColumn("document", sql`tsvector`, (column) => column.notNull())
                .execute();
            await db.schema.createIndex("note_search_by_document")
                .on("note_search")
                .using("gin")
                .column("document")
                .execute();
            return;
        }

        // Ids that are never reused, so a status's words can't be found as another's.
        await db.schema.createTable("note_search")
            .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().unique().references("notes.id").onDelete("cascade"),
            )
            .execute();
        await sql`
            CREATE VIRTUAL TABLE note_search_text USING fts5(
                text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 0'
            )
        `.execute(db);
        // What the cascade does on Postgres: a deleted status's words go with it.
        await sql`
            CREATE TRIGGER note_search_deleted AFTER DELETE ON note_search BEGIN
                DELETE FROM note_search_text WHERE rowid = old.id;
            END
        `.execute(db);
    },
};
