import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * When an account's profile last changed: a remote account's `updated_at` as its User carried it,
 * and a local account's own edit time. A User version older than the held one is discarded by it.
 * `null` where there isn't one.
 */
export const accountUpdatedAt: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("accounts")
            .addColumn("updated_at", columnTypes(db).timestamp)
            .execute();
    },
};
