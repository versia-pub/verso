import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Jobs' groups, such as the instance a delivery is for, so a worker can limit each one. */
export const jobGroups: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("jobs").addColumn("group_key", "text").execute();
        await db.schema.createIndex("jobs_by_group").on("jobs")
            .columns(["queue", "group_key"])
            .execute();
    },
};
