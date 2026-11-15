import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * What Versia's Profile extension adds to an account (pronouns, birthday, location and time zone),
 * a remote account's web page, and the images of its Decorations extension, apart from the header,
 * which stays in `header_id`.
 */
export const userProfiles: Migration = {
    up: async (db: Kysely<unknown>) => {
        // One at a time, since SQLite adds only one column per statement.
        await db.schema.alterTable("accounts")
            .addColumn(
                "pronouns",
                columnTypes(db).json,
                (column) => column.notNull().defaultTo(sql`'{}'`),
            )
            .execute();
        for (const name of ["birthday", "location", "timezone", "url"]) {
            await db.schema.alterTable("accounts").addColumn(name, "text").execute();
        }

        await db.schema.createTable("account_decorations")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("kind", "text", (column) => column.notNull())
            .addColumn("position", "integer", (column) => column.notNull())
            // Local media is deleted with its account, which a decoration must not block.
            .addColumn(
                "media_id",
                "text",
                (column) => column.notNull().references("media.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("account_decorations_pkey", ["account_id", "kind", "position"])
            .execute();

        await db.schema.createIndex("account_decorations_by_media").on("account_decorations")
            .column("media_id")
            .execute();
    },
};
