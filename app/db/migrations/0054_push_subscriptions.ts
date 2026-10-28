import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const pushSubscriptions: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("push_subscriptions")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "token_id",
                "text",
                (column) =>
                    column.notNull().unique().references("access_tokens.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("access_token", "text", (column) => column.notNull())
            .addColumn("endpoint", "text", (column) => column.notNull())
            .addColumn("p256dh", "text", (column) => column.notNull())
            .addColumn("auth", "text", (column) => column.notNull())
            .addColumn("alerts", types.json, (column) => column.notNull())
            .addColumn("policy", "text", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // For pushing a user's notifications to each of their subscriptions.
        await db.schema.createIndex("push_subscriptions_by_account")
            .on("push_subscriptions")
            .column("account_id")
            .execute();
    },
};
