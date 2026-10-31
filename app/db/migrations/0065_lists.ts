import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The lists of accounts that users make, and the accounts in them. */
export const lists: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("lists")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("title", "text", (column) => column.notNull())
            .addColumn("replies_policy", "text", (column) => column.notNull())
            .addColumn("exclusive", "boolean", (column) => column.notNull())
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("lists_by_account").on("lists")
            .columns(["account_id", "id"])
            .execute();

        await db.schema.createTable("list_accounts")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "list_id",
                "text",
                (column) => column.notNull().references("lists.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "follow_id",
                "text",
                (column) => column.references("follows.id").onDelete("cascade"),
            )
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("list_accounts_by_pair").on("list_accounts")
            .unique()
            .columns(["list_id", "account_id"])
            .execute();

        // For finding the lists an account is in, and for removing it when it is deleted.
        await db.schema.createIndex("list_accounts_by_account").on("list_accounts")
            .column("account_id")
            .execute();

        // For removing members when their follow is removed.
        await db.schema.createIndex("list_accounts_by_follow").on("list_accounts")
            .column("follow_id")
            .execute();
    },
};
