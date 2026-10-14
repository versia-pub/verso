import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const jobs: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);
        await db.schema.createTable("jobs")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("queue", "text", (column) => column.notNull())
            .addColumn("payload", types.json, (column) => column.notNull())
            .addColumn("priority", "integer", (column) => column.notNull())
            .addColumn("run_at", types.timestamp, (column) => column.notNull())
            .addColumn("attempts", "integer", (column) => column.notNull())
            .addColumn("max_attempts", "integer", (column) => column.notNull())
            .addColumn("lease_owner", "text")
            .addColumn("lease_expires_at", types.timestamp)
            .addColumn("dedupe_key", "text", (column) => column.unique())
            .addColumn("last_error", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();
        await db.schema.createIndex("jobs_by_queue_and_time").on("jobs")
            .columns(["queue", "run_at"])
            .execute();
    },
};
