import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The files attached to notes, in order. A file is attached to one note at most. */
export const noteMedia: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("note_media")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "media_id",
                "text",
                (column) => column.notNull().references("media.id").onDelete("cascade"),
            )
            .addColumn("position", "integer", (column) => column.notNull())
            .addPrimaryKeyConstraint("note_media_pkey", ["note_id", "position"])
            .execute();

        await db.schema.createIndex("note_media_by_media").on("note_media")
            .unique()
            .column("media_id")
            .execute();
    },
};
