import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Claims jobs by when they are due, then in the order they were made, so a claim reads only due
 * jobs: ones that wait, such as a paused instance's deliveries, sort after them instead of being
 * read and skipped on every poll. Priorities go, since nothing set them.
 */
export const claimsByTime: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.dropIndex("jobs_claimable").execute();
        await db.schema.alterTable("jobs").dropColumn("priority").execute();
        await db.schema.createIndex("jobs_claimable").on("jobs")
            .columns(["queue", "run_at", "id"])
            .where(sql<boolean>`finished_at is null and attempts < max_attempts`)
            .execute();
    },
};
