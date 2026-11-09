import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** When an admin suspended an account, or `null` if it isn't suspended. */
export const suspensions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("accounts")
            .addColumn("suspended_at", columnTypes(db).timestamp)
            .execute();
    },
};
