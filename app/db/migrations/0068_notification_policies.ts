import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Users' notification policies, the notifications they filtered, and the requests of the accounts
 * whose mentions they filtered.
 */
export const notificationPolicies: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("notifications")
            .addColumn("filtered", "boolean", (column) => column.notNull().defaultTo(false))
            .execute();

        // For counting a request's filtered mentions, which are few.
        await db.schema.createIndex("notifications_filtered_by_sender").on("notifications")
            .columns(["account_id", "from_account_id"])
            .where(sql<boolean>`filtered`)
            .execute();

        await db.schema.createTable("notification_policies")
            .addColumn(
                "account_id",
                "text",
                (column) => column.primaryKey().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("for_not_following", "text", (column) => column.notNull())
            .addColumn("for_not_followers", "text", (column) => column.notNull())
            .addColumn("for_new_accounts", "text", (column) => column.notNull())
            .addColumn("for_private_mentions", "text", (column) => column.notNull())
            .addColumn("for_limited_accounts", "text", (column) => column.notNull())
            .addColumn("updated_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createTable("notification_requests")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "from_account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "last_note_id",
                "text",
                (column) => column.references("notes.id").onDelete("set null"),
            )
            .addColumn("notifications_count", "integer", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addColumn("updated_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("notification_requests_by_pair").on("notification_requests")
            .unique()
            .columns(["account_id", "from_account_id"])
            .execute();
    },
};
