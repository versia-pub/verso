import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const follows: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("follows")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "follower_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "followee_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("accepted", "boolean", (column) => column.notNull())
            .addColumn("show_reblogs", "boolean", (column) => column.notNull().defaultTo(true))
            .addColumn("notify", "boolean", (column) => column.notNull().defaultTo(false))
            .addColumn("languages", types.json)
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("follows_by_pair").on("follows")
            .unique()
            .columns(["follower_id", "followee_id"])
            .execute();

        await db.schema.createIndex("follows_by_followee").on("follows")
            .column("followee_id")
            .execute();
    },
};
