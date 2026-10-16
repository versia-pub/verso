import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const accounts: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("accounts")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("username", "text", (column) => column.notNull())
            // A reference to the instances table, once it exists.
            .addColumn("instance_id", "text")
            .addColumn("remote_id", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // Postgres treats nulls as distinct, so local accounts are keyed on an empty instance.
        await db.schema.createIndex("accounts_by_username").on("accounts")
            .unique()
            .column(sql`coalesce(instance_id, '')`)
            .column(sql`lower(username)`)
            .execute();

        await db.schema.createIndex("accounts_by_remote_id").on("accounts")
            .unique()
            .columns(["instance_id", "remote_id"])
            .execute();

        await db.schema.createTable("identities")
            .addColumn("issuer", "text", (column) => column.notNull())
            .addColumn("subject", "text", (column) => column.notNull())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("identities_pkey", ["issuer", "subject"])
            .execute();

        await db.schema.createIndex("identities_by_account").on("identities")
            .column("account_id")
            .execute();
    },
};
