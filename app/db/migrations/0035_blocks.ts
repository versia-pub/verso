import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const blocks: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("blocks")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "target_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("blocks_by_pair").on("blocks")
            .unique()
            .columns(["account_id", "target_id"])
            .execute();

        await db.schema.createIndex("blocks_by_target").on("blocks")
            .column("target_id")
            .execute();
    },
};
