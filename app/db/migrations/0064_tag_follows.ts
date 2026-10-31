import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The hashtags that users follow. */
export const tagFollows: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("tag_follows")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("tag", "text", (column) => column.notNull().references("tags.name"))
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("tag_follows_by_pair").on("tag_follows")
            .unique()
            .columns(["account_id", "tag"])
            .execute();

        // For finding who follows a status's hashtags, to stream it to them.
        await db.schema.createIndex("tag_follows_by_tag").on("tag_follows")
            .columns(["tag", "account_id"])
            .execute();
    },
};
