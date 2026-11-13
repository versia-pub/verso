import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Each local user's settings for the web app, as JSON the app writes. It is text, not `jsonb`, so
 * it is read back exactly as written: Postgres reorders keys in `jsonb` and refuses `\u0000`.
 */
export const webPreferences: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("web_preferences")
            .addColumn(
                "account_id",
                "text",
                (column) => column.primaryKey().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("data", "text", (column) => column.notNull())
            .addColumn("version", "integer", (column) => column.notNull())
            .addColumn("updated_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();
    },
};
