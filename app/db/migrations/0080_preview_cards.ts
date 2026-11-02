import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Previews of the pages that statuses link to, and the statuses that show each. */
export const previewCards: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("preview_cards")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("url", "text", (column) => column.notNull().unique())
            .addColumn("title", "text", (column) => column.notNull())
            .addColumn("description", "text", (column) => column.notNull())
            .addColumn("language", "text")
            .addColumn("author_name", "text", (column) => column.notNull())
            .addColumn("author_url", "text", (column) => column.notNull())
            .addColumn("provider_name", "text", (column) => column.notNull())
            .addColumn("provider_url", "text", (column) => column.notNull())
            .addColumn(
                "image_id",
                "text",
                (column) => column.references("media.id").onDelete("set null"),
            )
            .addColumn("image_description", "text", (column) => column.notNull())
            .addColumn("published_at", types.timestamp)
            .addColumn("link_type", "text", (column) => column.notNull())
            .addColumn("fetched_at", types.timestamp, (column) => column.notNull())
            .execute();

        // For finding the cards whose media is in use.
        await db.schema.createIndex("preview_cards_by_image")
            .on("preview_cards")
            .column("image_id")
            .execute();

        await db.schema.createTable("note_preview_cards")
            .addColumn(
                "note_id",
                "text",
                (column) => column.primaryKey().references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "card_id",
                "text",
                (column) => column.notNull().references("preview_cards.id").onDelete("cascade"),
            )
            .addColumn("url", "text", (column) => column.notNull())
            .execute();

        await db.schema.createIndex("note_preview_cards_by_card")
            .on("note_preview_cards")
            .column("card_id")
            .execute();
    },
};
