import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { checkForeignKeys, columnTypes, usesSqlite } from "../columns.ts";

/** Apps may be public clients, which have no secret, so `client_secret_hash` may be null. */
export const publicApps: Migration = {
    up: async (db: Kysely<unknown>) => {
        if (!usesSqlite(db)) {
            await db.schema.alterTable("apps")
                .alterColumn("client_secret_hash", (column) => column.dropNotNull())
                .execute();
            return;
        }

        // SQLite can't change a column, so the table is rebuilt with it.
        const types = columnTypes(db);

        await db.schema.createTable("apps_new")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("name", "text", (column) => column.notNull())
            .addColumn("website", "text")
            .addColumn("redirect_uris", types.json, (column) => column.notNull())
            .addColumn("scopes", types.json, (column) => column.notNull())
            .addColumn("client_id", "text", (column) => column.notNull().unique())
            .addColumn("client_secret_hash", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await sql`insert into apps_new
            (id, name, website, redirect_uris, scopes, client_id, client_secret_hash, created_at)
            select id, name, website, redirect_uris, scopes, client_id, client_secret_hash,
                created_at
            from apps`.execute(db);
        await db.schema.dropTable("apps").execute();
        await db.schema.alterTable("apps_new").renameTo("apps").execute();

        await checkForeignKeys(db);
    },
};
