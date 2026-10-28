import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { usesSqlite } from "../columns.ts";

/** The words of each account's names and domain, for searching them, as `note_search` has. */
export const accountSearch: Migration = {
    up: async (db: Kysely<unknown>) => {
        if (!usesSqlite(db)) {
            await db.schema.createTable("account_search")
                .addColumn(
                    "account_id",
                    "text",
                    (column) => column.primaryKey().references("accounts.id").onDelete("cascade"),
                )
                .addColumn("document", sql`tsvector`, (column) => column.notNull())
                .execute();
            await db.schema.createIndex("account_search_by_document")
                .on("account_search")
                .using("gin")
                .column("document")
                .execute();
            return;
        }

        await db.schema.createTable("account_search")
            .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().unique().references("accounts.id").onDelete("cascade"),
            )
            .execute();
        await sql`
            CREATE VIRTUAL TABLE account_search_text USING fts5(
                text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 0'
            )
        `.execute(db);
        await sql`
            CREATE TRIGGER account_search_deleted AFTER DELETE ON account_search BEGIN
                DELETE FROM account_search_text WHERE rowid = old.id;
            END
        `.execute(db);
    },
};
