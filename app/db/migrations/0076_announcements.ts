import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Announcements, and which users dismissed them. */
export const announcements: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("announcements")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("text", "text", (column) => column.notNull())
            .addColumn("content_html", "text", (column) => column.notNull())
            // Not referencing `accounts` or `notes`, so that the rest stay when they are deleted.
            .addColumn("account_ids", types.json, (column) => column.notNull())
            .addColumn("note_ids", types.json, (column) => column.notNull())
            .addColumn("starts_at", types.timestamp)
            .addColumn("ends_at", types.timestamp)
            .addColumn("all_day", "boolean", (column) => column.notNull())
            .addColumn("scheduled_at", types.timestamp)
            .addColumn("published_at", types.timestamp)
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addColumn("updated_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createTable("announcement_dismissals")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "announcement_id",
                "text",
                (column) => column.notNull().references("announcements.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("announcement_dismissals_pkey", [
                "account_id",
                "announcement_id",
            ])
            .execute();

        // For removing an announcement's dismissals when it is deleted.
        await db.schema.createIndex("announcement_dismissals_by_announcement")
            .on("announcement_dismissals")
            .column("announcement_id")
            .execute();
    },
};
