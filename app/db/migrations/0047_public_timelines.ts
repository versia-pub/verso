import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The notes on the public timelines, newest first, so a page of them is read without going through
 * every other note: public ones that aren't shares, and of those, the local ones.
 */
export const publicTimelines: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("notes_public").on("notes")
            .column("id")
            .where(sql<boolean>`visibility = 'public' and reblog_of_id is null`)
            .execute();

        await db.schema.createIndex("notes_public_local").on("notes")
            .column("id")
            .where(
                sql<boolean>`visibility = 'public' and reblog_of_id is null
                and instance_id is null`,
            )
            .execute();
    },
};
