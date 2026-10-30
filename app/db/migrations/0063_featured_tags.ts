import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The hashtags that users feature on their profiles. */
export const featuredTags: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("featured_tags")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("tag", "text", (column) => column.notNull().references("tags.name"))
            .addColumn("name", "text", (column) => column.notNull())
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("featured_tags_by_pair").on("featured_tags")
            .unique()
            .columns(["account_id", "tag"])
            .execute();
    },
};
