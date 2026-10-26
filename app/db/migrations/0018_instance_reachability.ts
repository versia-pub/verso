import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Whether instances can be reached: how many times in a row they failed, and how long to wait. */
export const instanceReachability: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("instances")
            .addColumn("failures", "integer", (column) => column.notNull().defaultTo(0))
            .execute();
        await db.schema.alterTable("instances").addColumn("parked_until", types.timestamp)
            .execute();
    },
};
