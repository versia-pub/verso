import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** What is trending, and which hashtags and accounts admins approved or rejected for trending. */
export const trends: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        // Null until an admin decides, and then the instance's default applies.
        await db.schema.alterTable("tags").addColumn("trendable", "boolean").execute();
        await db.schema.alterTable("accounts").addColumn("trendable", "boolean").execute();

        await db.schema.createTable("trending_tags")
            .addColumn(
                "name",
                "text",
                (column) => column.primaryKey().references("tags.name").onDelete("cascade"),
            )
            .addColumn("score", "double precision", (column) => column.notNull())
            .addColumn("max_score", "double precision", (column) => column.notNull())
            .addColumn("max_score_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("trending_tags_by_score")
            .on("trending_tags")
            .column("score")
            .execute();

        await db.schema.createTable("trending_statuses")
            .addColumn(
                "note_id",
                "text",
                (column) => column.primaryKey().references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("score", "double precision", (column) => column.notNull())
            .execute();

        await db.schema.createIndex("trending_statuses_by_score")
            .on("trending_statuses")
            .column("score")
            .execute();

        // For removing an account's trending statuses when it is deleted.
        await db.schema.createIndex("trending_statuses_by_account")
            .on("trending_statuses")
            .column("account_id")
            .execute();
    },
};
