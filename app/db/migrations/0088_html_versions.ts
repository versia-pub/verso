import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Which version of the sanitiser remote HTML went through. Rows stored before have 0: their HTML is
 * as received, and is sanitised when shown until a job sanitises it in place.
 */
export const htmlVersions: Migration = {
    up: async (db: Kysely<unknown>) => {
        for (const table of ["notes", "note_versions", "accounts"]) {
            await db.schema.alterTable(table)
                .addColumn("html_version", "integer", (column) => column.notNull().defaultTo(0))
                .execute();
        }
    },
};
