import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** When an admin deleted a local account, kept empty so its username and login stay taken. */
export const accountDeletions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("accounts")
            .addColumn("deleted_at", columnTypes(db).timestamp)
            .execute();
    },
};
