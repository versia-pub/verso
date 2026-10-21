import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const notes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("notes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "instance_id",
                "text",
                (column) => column.references("instances.id").onDelete("cascade"),
            )
            .addColumn("remote_id", "text")
            .addColumn("visibility", "text", (column) => column.notNull())
            .addColumn("content", "text", (column) => column.notNull())
            .addColumn("content_format", "text", (column) => column.notNull())
            .addColumn("content_html", "text", (column) => column.notNull())
            .addColumn("spoiler_text", "text", (column) => column.notNull().defaultTo(""))
            .addColumn("sensitive", "boolean", (column) => column.notNull().defaultTo(false))
            .addColumn("language", "text")
            .addColumn(
                "in_reply_to_id",
                "text",
                (column) => column.references("notes.id").onDelete("set null"),
            )
            .addColumn(
                "in_reply_to_account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("set null"),
            )
            .addColumn("replies_count", "integer", (column) => column.notNull().defaultTo(0))
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addColumn("edited_at", types.timestamp)
            .execute();

        await db.schema.createIndex("notes_by_remote_id").on("notes")
            .unique()
            .columns(["instance_id", "remote_id"])
            .execute();

        // For an account's notes, and timelines of the accounts someone follows, newest first.
        await db.schema.createIndex("notes_by_account").on("notes")
            .columns(["account_id", "id"])
            .execute();

        await db.schema.createIndex("notes_by_reply").on("notes")
            .column("in_reply_to_id")
            .execute();

        await db.schema.createTable("note_mentions")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("note_mentions_pkey", ["note_id", "account_id"])
            .execute();

        await db.schema.createIndex("note_mentions_by_account").on("note_mentions")
            .column("account_id")
            .execute();

        await db.schema.createTable("note_tags")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn("name", "text", (column) => column.notNull())
            .addPrimaryKeyConstraint("note_tags_pkey", ["note_id", "name"])
            .execute();

        await db.schema.createIndex("note_tags_by_name").on("note_tags")
            .column("name")
            .execute();
    },
};
