import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The domains a local account says may credit it, as a list. */
export const attributionDomains: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("accounts")
            .addColumn(
                "attribution_domains",
                columnTypes(db).json,
                (column) => column.notNull().defaultTo(sql`'[]'`),
            )
            .execute();
    },
};
