import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const mutes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("mutes")
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
            .addColumn("notifications", "boolean", (column) => column.notNull())
            .addColumn("expires_at", types.timestamp)
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("mutes_by_pair").on("mutes")
            .unique()
            .columns(["account_id", "target_id"])
            .execute();

        await db.schema.createIndex("mutes_by_target").on("mutes")
            .column("target_id")
            .execute();
    },
};
