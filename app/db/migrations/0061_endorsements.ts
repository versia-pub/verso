import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The accounts that users feature on their profiles. */
export const endorsements: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("endorsements")
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
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("endorsements_by_pair").on("endorsements")
            .unique()
            .columns(["account_id", "target_id"])
            .execute();

        await db.schema.createIndex("endorsements_by_target").on("endorsements")
            .column("target_id")
            .execute();
    },
};
