import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Which tabs an account's profile shows: media, media with replies, and featured accounts. */
export const profileTabs: Migration = {
    up: async (db: Kysely<unknown>) => {
        // One at a time, since SQLite adds only one column per statement.
        for (const name of ["show_media", "show_media_replies", "show_featured"]) {
            await db.schema.alterTable("accounts")
                .addColumn(name, "boolean", (column) => column.notNull().defaultTo(sql`true`))
                .execute();
        }
    },
};
