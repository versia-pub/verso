import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Reports that other instances send. */
export const remoteReports: Migration = {
    up: async (db: Kysely<unknown>) => {
        // Kept, as reports are when their reporter's account is deleted.
        await db.schema.alterTable("reports")
            .addColumn(
                "instance_id",
                "text",
                (column) => column.references("instances.id").onDelete("set null"),
            )
            .execute();
        await db.schema.alterTable("reports")
            .addColumn("digest", "text")
            .execute();

        // So that a report received again is stored once.
        await db.schema.createIndex("reports_received").on("reports")
            .columns(["instance_id", "digest", "target_account_id"])
            .unique()
            .execute();
    },
};
