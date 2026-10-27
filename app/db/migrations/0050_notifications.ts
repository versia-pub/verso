import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Local users' notifications. Each links what it is about, so that undoing a like, reaction, boost
 * or follow, or deleting the status, deletes the notification with it.
 */
export const notifications: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("notifications")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("type", "text", (column) => column.notNull())
            .addColumn(
                "from_account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "note_id",
                "text",
                (column) => column.references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "share_id",
                "text",
                (column) => column.references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "like_id",
                "text",
                (column) => column.references("likes.id").onDelete("cascade"),
            )
            .addColumn(
                "reaction_id",
                "text",
                (column) => column.references("reactions.id").onDelete("cascade"),
            )
            .addColumn(
                "follow_id",
                "text",
                (column) => column.references("follows.id").onDelete("cascade"),
            )
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // For an account's notifications, newest first.
        await db.schema.createIndex("notifications_by_account").on("notifications")
            .columns(["account_id", "id"])
            .execute();

        // For deleting them with what they link.
        const links = [
            "from_account_id",
            "note_id",
            "share_id",
            "like_id",
            "reaction_id",
            "follow_id",
        ];
        for (const column of links) {
            await db.schema.createIndex(`notifications_by_${column}`).on("notifications")
                .column(column)
                .execute();
        }
    },
};
