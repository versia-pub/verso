import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The files a note had attached before each edit, with their descriptions then. */
export const versionMedia: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("note_versions")
            .addColumn(
                "media",
                columnTypes(db).json,
                (column) => column.notNull().defaultTo(sql`'[]'`),
            )
            .execute();
    },
};
