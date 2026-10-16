import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const rateLimits: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("rate_limits")
            .addColumn("key", "text", (column) => column.primaryKey())
            .addColumn("count", "integer", (column) => column.notNull())
            .addColumn("resets_at", types.timestamp, (column) => column.notNull())
            .execute();

        // For deleting windows that have ended.
        await db.schema.createIndex("rate_limits_by_reset").on("rate_limits")
            .column("resets_at")
            .execute();
    },
};
