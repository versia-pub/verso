import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The accounts that users asked not to be suggested to follow. */
export const suggestionDismissals: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("suggestion_dismissals")
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
            .addPrimaryKeyConstraint(
                "suggestion_dismissals_pkey",
                ["account_id", "target_id"],
            )
            .execute();

        await db.schema.createIndex("suggestion_dismissals_by_target")
            .on("suggestion_dismissals")
            .column("target_id")
            .execute();
    },
};
