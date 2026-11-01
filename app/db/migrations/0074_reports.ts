import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Reports of accounts to the instance's moderators. */
export const reports: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("reports")
            .addColumn("id", "text", (column) => column.primaryKey())
            // Kept when the reporter's account is deleted.
            .addColumn(
                "account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("set null"),
            )
            .addColumn(
                "target_account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("category", "text", (column) => column.notNull())
            .addColumn("comment", "text", (column) => column.notNull())
            // Not referencing `notes`, so that the ids stay when the statuses are deleted.
            .addColumn("note_ids", types.json, (column) => column.notNull())
            .addColumn("rule_ids", types.json)
            .addColumn("forwarded", "boolean", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addColumn("resolved_at", types.timestamp)
            .execute();

        // For removing an account's reports, and theirs as the reporter.
        await db.schema.createIndex("reports_by_target").on("reports")
            .column("target_account_id")
            .execute();
        await db.schema.createIndex("reports_by_account").on("reports")
            .column("account_id")
            .execute();
    },
};
