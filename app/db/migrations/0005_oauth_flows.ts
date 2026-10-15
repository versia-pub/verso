import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const oauthFlows: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("oauth_flows")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "app_id",
                "text",
                (column) => column.notNull().references("apps.id").onDelete("cascade"),
            )
            .addColumn("redirect_uri", "text", (column) => column.notNull())
            .addColumn("scopes", types.json, (column) => column.notNull())
            .addColumn("state", "text")
            .addColumn("code_challenge", "text")
            .addColumn("issuer", "text")
            .addColumn("login", types.json)
            .addColumn(
                "account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("cascade"),
            )
            .addColumn("code_hash", "text", (column) => column.unique())
            .addColumn("expires_at", types.timestamp, (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
