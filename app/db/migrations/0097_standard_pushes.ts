import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Whether each push subscription takes the `aes128gcm` encoding or the older `aesgcm` one. The
 * subscriptions there were already took `aes128gcm`, so they keep it.
 */
export const standardPushes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("push_subscriptions")
            .addColumn("standard", "boolean", (column) => column.notNull().defaultTo(true))
            .execute();
    },
};
