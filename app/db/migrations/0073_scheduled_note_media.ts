import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The media reserved for scheduled statuses, in order, until they are posted. Media is reserved for
 * one scheduled status at most.
 */
export const scheduledNoteMedia: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("scheduled_note_media")
            .addColumn(
                "scheduled_note_id",
                "text",
                (column) => column.notNull().references("scheduled_notes.id").onDelete("cascade"),
            )
            // Not cascading, so that removing unused media fails rather than take reserved media.
            .addColumn("media_id", "text", (column) => column.notNull().references("media.id"))
            .addColumn("position", "integer", (column) => column.notNull())
            .addPrimaryKeyConstraint("scheduled_note_media_pkey", ["scheduled_note_id", "position"])
            .execute();

        await db.schema.createIndex("scheduled_note_media_by_media").on("scheduled_note_media")
            .unique()
            .column("media_id")
            .execute();
    },
};
