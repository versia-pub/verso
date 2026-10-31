import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Users' direct conversations, and the statuses in them. */
export const conversations: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("conversations")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("thread_id", "text", (column) => column.notNull())
            .addColumn("participants", "text", (column) => column.notNull())
            // Not cascading: its other statuses keep it, once the next latest is found.
            .addColumn(
                "last_note_id",
                "text",
                (column) => column.references("notes.id").onDelete("set null"),
            )
            .addColumn("unread", "boolean", (column) => column.notNull())
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("conversations_by_key").on("conversations")
            .unique()
            .columns(["account_id", "thread_id", "participants"])
            .execute();

        await db.schema.createIndex("conversations_by_last").on("conversations")
            .columns(["account_id", "last_note_id"])
            .execute();

        await db.schema.createTable("conversation_notes")
            .addColumn(
                "conversation_id",
                "text",
                (column) => column.notNull().references("conversations.id").onDelete("cascade"),
            )
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("conversation_notes_pkey", ["conversation_id", "note_id"])
            .execute();

        // For removing them when their status is deleted.
        await db.schema.createIndex("conversation_notes_by_note").on("conversation_notes")
            .column("note_id")
            .execute();
    },
};
