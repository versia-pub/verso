import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Finds dead letters by when they died, so deleting old ones doesn't read every job. */
export const deadLetterIndex: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("jobs_dead").on("jobs")
            .column("run_at")
            .where(sql<boolean>`finished_at is null and attempts >= max_attempts`)
            .execute();
    },
};
