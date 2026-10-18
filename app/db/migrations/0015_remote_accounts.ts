import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Accounts' pictures, in `media`, and when a remote account was last seen. */
export const remoteAccounts: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        // One at a time, since SQLite adds only one column per statement.
        for (const name of ["avatar_id", "header_id"]) {
            await db.schema.alterTable("accounts")
                .addColumn(
                    name,
                    "text",
                    (column) => column.references("media.id").onDelete("set null"),
                )
                .execute();
        }

        await db.schema.alterTable("accounts").addColumn("fetched_at", types.timestamp).execute();
    },
};
