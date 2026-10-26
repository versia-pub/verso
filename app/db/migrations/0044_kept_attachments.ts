import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { checkForeignKeys, usesSqlite } from "../columns.ts";

/**
 * Media attached to a status can't be deleted, so removing unused uploads fails rather than
 * deleting an upload that was just attached to a status. Uploads are indexed by creation time,
 * which is the order they are removed in.
 */
export const keptAttachments: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("media_uploads_by_created_at").on("media")
            .columns(["created_at", "id"])
            .where(sql.ref("account_id"), "is not", null)
            .execute();

        if (!usesSqlite(db)) {
            await db.schema.alterTable("note_media")
                .dropConstraint("note_media_media_id_fkey")
                .execute();
            await db.schema.alterTable("note_media")
                .addForeignKeyConstraint("note_media_media_id_fkey", ["media_id"], "media", ["id"])
                .execute();
            return;
        }

        // SQLite can't change a constraint, so the table is rebuilt with it.
        await db.schema.createTable("note_media_new")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("media_id", "text", (column) => column.notNull().references("media.id"))
            .addColumn("position", "integer", (column) => column.notNull())
            .addPrimaryKeyConstraint("note_media_new_pkey", ["note_id", "position"])
            .execute();

        await sql`insert into note_media_new (note_id, media_id, position)
            select note_id, media_id, position from note_media`.execute(db);
        await db.schema.dropTable("note_media").execute();
        await db.schema.alterTable("note_media_new").renameTo("note_media").execute();

        // Dropping the table dropped its index.
        await db.schema.createIndex("note_media_by_media").on("note_media")
            .unique()
            .column("media_id")
            .execute();

        await checkForeignKeys(db);
    },
};
