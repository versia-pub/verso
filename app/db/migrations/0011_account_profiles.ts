import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const accountProfiles: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);
        const columns = [
            ["display_name", "text", sql`''`],
            ["note", "text", sql`''`],
            ["fields", types.json, sql`'[]'`],
            ["locked", "boolean", sql`false`],
            ["bot", "boolean", sql`false`],
            ["discoverable", "boolean", sql`false`],
            ["indexable", "boolean", sql`false`],
            ["hide_collections", "boolean", sql`false`],
            ["default_visibility", "text", sql`'public'`],
            ["default_sensitive", "boolean", sql`false`],
            ["default_language", "text", sql`''`],
            ["statuses_count", "integer", sql`0`],
            ["followers_count", "integer", sql`0`],
            ["following_count", "integer", sql`0`],
        ] as const;

        // One at a time, since SQLite adds only one column per statement.
        for (const [name, type, value] of columns) {
            await db.schema.alterTable("accounts")
                .addColumn(name, type, (column) => column.notNull().defaultTo(value))
                .execute();
        }

        await db.schema.alterTable("accounts")
            .addColumn("last_status_at", types.timestamp)
            .execute();
    },
};
