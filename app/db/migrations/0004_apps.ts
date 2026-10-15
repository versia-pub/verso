import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const apps: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("apps")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("name", "text", (column) => column.notNull())
            .addColumn("website", "text")
            .addColumn("redirect_uris", types.json, (column) => column.notNull())
            .addColumn("scopes", types.json, (column) => column.notNull())
            .addColumn("client_id", "text", (column) => column.notNull().unique())
            .addColumn("client_secret_hash", "text", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
