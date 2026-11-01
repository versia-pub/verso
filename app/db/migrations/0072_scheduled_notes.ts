import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Statuses that local users scheduled, with what each will be posted with. */
export const scheduledNotes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("scheduled_notes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("scheduled_at", types.timestamp, (column) => column.notNull())
            .addColumn("params", types.json, (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // For finding the statuses that are due.
        await db.schema.createIndex("scheduled_notes_due").on("scheduled_notes")
            .column("scheduled_at")
            .execute();

        // For counting each account's, in all and on one day.
        await db.schema.createIndex("scheduled_notes_by_account").on("scheduled_notes")
            .columns(["account_id", "scheduled_at"])
            .execute();
    },
};
