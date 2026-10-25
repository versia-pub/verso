import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Groups of jobs that wait, such as deliveries to an instance that is down, as one row each rather
 * than by putting off every job. Due jobs are claimed in the order they were made, which their
 * ids sort in.
 */
export const jobPauses: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("job_pauses")
            .addColumn("queue", "text", (column) => column.notNull())
            .addColumn("group_key", "text", (column) => column.notNull())
            .addColumn("until", types.timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("job_pauses_pkey", ["queue", "group_key"])
            .execute();

        await db.schema.dropIndex("jobs_claimable").execute();
        await db.schema.createIndex("jobs_claimable").on("jobs")
            .columns(["queue", "priority desc", "id"])
            .where(sql<boolean>`finished_at is null and attempts < max_attempts`)
            .execute();
    },
};
