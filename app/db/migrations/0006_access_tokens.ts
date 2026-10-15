import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const accessTokens: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("access_tokens")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("token_hash", "text", (column) => column.notNull().unique())
            .addColumn(
                "app_id",
                "text",
                (column) => column.notNull().references("apps.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("cascade"),
            )
            .addColumn("scopes", types.json, (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("access_tokens_by_account").on("access_tokens")
            .column("account_id")
            .execute();
    },
};
