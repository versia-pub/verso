import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Remote statuses by age, so the old ones can be pruned without reading the rest, and the rows that
 * refer to a status by it, so that deleting statuses in bulk doesn't scan those tables for each.
 */
export const remoteNotePruning: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("notes_remote_by_age").on("notes")
            .columns(["created_at", "id"])
            .where(sql<boolean>`instance_id is not null`)
            .execute();
        await db.schema.createIndex("reactions_by_note").on("reactions")
            .column("note_id")
            .execute();
        await db.schema.createIndex("conversations_by_last_note").on("conversations")
            .column("last_note_id")
            .execute();
        await db.schema.createIndex("notification_requests_by_last_note")
            .on("notification_requests")
            .column("last_note_id")
            .execute();
    },
};
