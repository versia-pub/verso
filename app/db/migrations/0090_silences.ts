import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** When an admin silenced an account, or `null` if it isn't silenced. */
export const silences: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("accounts")
            .addColumn("silenced_at", columnTypes(db).timestamp)
            .execute();
    },
};
