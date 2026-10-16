import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { checkForeignKeys, columnTypes, usesSqlite } from "../columns.ts";

export const instances: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("instances")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("domain", "text", (column) => column.notNull().unique())
            .addColumn("protocol", "text", (column) => column.notNull())
            .addColumn("public_key", "text")
            .addColumn("key_fetched_at", types.timestamp)
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // An instance can't be deleted while accounts live on it.
        if (!usesSqlite(db)) {
            await db.schema.alterTable("accounts")
                .addForeignKeyConstraint(
                    "accounts_instance_id_fkey",
                    ["instance_id"],
                    "instances",
                    [
                        "id",
                    ],
                )
                .execute();
            return;
        }

        // SQLite can't add a constraint to a table, so the table is rebuilt with it, as in 0003.
        await db.schema.createTable("accounts_new")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("username", "text", (column) => column.notNull())
            .addColumn("instance_id", "text", (column) => column.references("instances.id"))
            .addColumn("remote_id", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await sql`insert into accounts_new (id, username, instance_id, remote_id, created_at)
            select id, username, instance_id, remote_id, created_at from accounts`.execute(db);
        await db.schema.dropTable("accounts").execute();
        await db.schema.alterTable("accounts_new").renameTo("accounts").execute();

        // Dropping the table dropped its indexes.
        await db.schema.createIndex("accounts_by_username").on("accounts")
            .unique()
            .expression(sql`coalesce(instance_id, ''), lower(username)`)
            .execute();

        await db.schema.createIndex("accounts_by_remote_id").on("accounts")
            .unique()
            .columns(["instance_id", "remote_id"])
            .execute();

        await checkForeignKeys(db);
    },
};
