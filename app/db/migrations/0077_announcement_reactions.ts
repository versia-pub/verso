import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Users' reactions to announcements, each with an emoji: a Unicode one, or a custom one. */
export const announcementReactions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("announcement_reactions")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "announcement_id",
                "text",
                (column) => column.notNull().references("announcements.id").onDelete("cascade"),
            )
            .addColumn("text", "text")
            .addColumn(
                "emoji_id",
                "text",
                (column) => column.references("emojis.id").onDelete("cascade"),
            )
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addCheckConstraint(
                "announcement_reactions_one_emoji",
                sql`(text is null) <> (emoji_id is null)`,
            )
            .execute();

        // An account reacts to an announcement with each emoji once.
        await db.schema.createIndex("announcement_reactions_by_text").on("announcement_reactions")
            .unique()
            .columns(["announcement_id", "account_id", "text"])
            .where(sql<boolean>`emoji_id is null`)
            .execute();
        await db.schema.createIndex("announcement_reactions_by_emoji").on("announcement_reactions")
            .unique()
            .columns(["announcement_id", "account_id", "emoji_id"])
            .where(sql<boolean>`text is null`)
            .execute();

        // For counting an announcement's reactions, and for deleting an announcement, an account or
        // an emoji, without scanning every reaction.
        await db.schema.createIndex("announcement_reactions_by_announcement")
            .on("announcement_reactions")
            .column("announcement_id")
            .execute();
        await db.schema.createIndex("announcement_reactions_by_account")
            .on("announcement_reactions")
            .column("account_id")
            .execute();
        await db.schema.createIndex("announcement_reactions_by_emoji_id")
            .on("announcement_reactions")
            .column("emoji_id")
            .execute();
    },
};
