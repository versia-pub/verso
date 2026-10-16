import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const roles: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("roles")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("name", "text", (column) => column.notNull())
            .addColumn("description", "text", (column) => column.notNull().defaultTo(""))
            .addColumn("permissions", types.json, (column) => column.notNull())
            .addColumn("priority", "integer", (column) => column.notNull().defaultTo(0))
            .addColumn("visible", "boolean", (column) => column.notNull().defaultTo(false))
            .addColumn("color", "text", (column) => column.notNull().defaultTo(""))
            .addColumn("icon", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("roles_by_name").on("roles")
            .unique()
            .column(sql`lower(name)`)
            .execute();

        await db.schema.createTable("account_roles")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "role_id",
                "text",
                (column) => column.notNull().references("roles.id").onDelete("cascade"),
            )
            .addColumn("issuer", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        // Postgres treats nulls as distinct, so an admin's assignments are keyed on an empty issuer.
        await db.schema.createIndex("account_roles_by_source").on("account_roles")
            .unique()
            .column("account_id")
            .column("role_id")
            .column(sql`coalesce(issuer, '')`)
            .execute();

        await db.schema.createIndex("account_roles_by_role").on("account_roles")
            .column("role_id")
            .execute();
    },
};
