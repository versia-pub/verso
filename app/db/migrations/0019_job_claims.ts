import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * An index of only the jobs a worker may claim, in the order it claims them, so finished jobs
 * retained for a while and dead letters don't slow every claim down. It replaces the index by queue
 * and time, which only claims used.
 */
export const jobClaims: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("jobs_claimable").on("jobs")
            .columns(["queue", "priority desc", "run_at", "id"])
            .where(sql<boolean>`finished_at is null and attempts < max_attempts`)
            .execute();
        await db.schema.dropIndex("jobs_by_queue_and_time").execute();
    },
};
