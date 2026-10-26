import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Statuses that accounts like, and how many likes each status has. */
export const likes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("likes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("likes_by_pair").on("likes")
            .unique()
            .columns(["account_id", "note_id"])
            .execute();

        // For the statuses an account likes, and the accounts that like a status, newest first.
        await db.schema.createIndex("likes_by_account").on("likes")
            .columns(["account_id", "id"])
            .execute();
        await db.schema.createIndex("likes_by_note").on("likes")
            .columns(["note_id", "id"])
            .execute();

        await db.schema.alterTable("notes")
            .addColumn("likes_count", "integer", (column) => column.notNull().defaultTo(0))
            .execute();
    },
};
