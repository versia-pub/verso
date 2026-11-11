import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The fetches clients can follow, such as of the replies of a thread a user opened. */
export const asyncRefreshes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("async_refreshes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("started_at", types.timestamp, (column) => column.notNull())
            .addColumn("finished_at", types.timestamp)
            .addColumn("result_count", "integer", (column) => column.notNull().defaultTo(0))
            .execute();
    },
};
