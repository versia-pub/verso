import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { checkForeignKeys, usesSqlite } from "../columns.ts";

/**
 * The hashtags statuses have used, each once, so that what is known about a hashtag has a place,
 * and finding hashtags by how they start reads one row for each. The ones used so far are added as
 * they are in `note_tags`, in lower case, and each status's hashtags refer to them.
 */
export const tags: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("tags")
            .addColumn("name", "text", (column) => column.primaryKey())
            .addColumn("display_name", "text", (column) => column.notNull())
            .execute();

        await sql`insert into tags (name, display_name)
            select distinct name, name from note_tags`.execute(db);

        if (!usesSqlite(db)) {
            // As `note_tags_by_name`, so that a prefix is a range of the index under any collation.
            await sql`CREATE INDEX tags_by_name ON tags (name text_pattern_ops)`.execute(db);
            await db.schema.alterTable("note_tags")
                .addForeignKeyConstraint("note_tags_name_fkey", ["name"], "tags", ["name"])
                .execute();
            return;
        }

        // SQLite can't add a constraint, so the table is rebuilt with it.
        await db.schema.createTable("note_tags_new")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("name", "text", (column) => column.notNull().references("tags.name"))
            .addPrimaryKeyConstraint("note_tags_pkey", ["note_id", "name"])
            .execute();

        await sql`insert into note_tags_new (note_id, name)
            select note_id, name from note_tags`.execute(db);
        await db.schema.dropTable("note_tags").execute();
        await db.schema.alterTable("note_tags_new").renameTo("note_tags").execute();

        // Dropping the table dropped its index.
        await db.schema.createIndex("note_tags_by_name").on("note_tags")
            .columns(["name", "note_id"])
            .execute();

        await checkForeignKeys(db);
    },
};
