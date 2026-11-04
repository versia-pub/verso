import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** What a notification policy does with notifications from bots. */
export const policyForBots: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notification_policies")
            .addColumn("for_bots", "text", (column) => column.notNull().defaultTo("accept"))
            .execute();
    },
};
