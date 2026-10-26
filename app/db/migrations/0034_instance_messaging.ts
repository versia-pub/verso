import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Whether each instance accepts instance messages, so Verso only sends them to those that do. */
export const instanceMessaging: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("instances")
            .addColumn("takes_messages", "boolean", (column) => column.notNull().defaultTo(false))
            .execute();
    },
};
