import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Accounts' reactions to statuses, each with an emoji: a Unicode one, or a custom one. */
export const reactions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("reactions")
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
            .addColumn("text", "text")
            .addColumn(
                "emoji_id",
                "text",
                (column) => column.references("emojis.id").onDelete("cascade"),
            )
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addCheckConstraint(
                "reactions_one_emoji",
                sql`(text is null) <> (emoji_id is null)`,
            )
            .execute();

        // An account reacts to a status with each emoji once.
        await db.schema.createIndex("reactions_by_text").on("reactions")
            .unique()
            .columns(["note_id", "account_id", "text"])
            .where(sql<boolean>`emoji_id is null`)
            .execute();
        await db.schema.createIndex("reactions_by_emoji").on("reactions")
            .unique()
            .columns(["note_id", "account_id", "emoji_id"])
            .where(sql<boolean>`text is null`)
            .execute();

        // For deleting an account or an emoji, without scanning every reaction.
        await db.schema.createIndex("reactions_by_account").on("reactions")
            .column("account_id")
            .execute();
        await db.schema.createIndex("reactions_by_emoji_id").on("reactions")
            .column("emoji_id")
            .execute();
    },
};
