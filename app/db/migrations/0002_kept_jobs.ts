import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const keptJobs: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);
        await db.schema.alterTable("jobs").addColumn("keep_until", types.timestamp).execute();
        await db.schema.alterTable("jobs").addColumn("finished_at", types.timestamp).execute();
    },
};
