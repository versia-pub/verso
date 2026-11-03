import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** What links are trending, and which preview cards and websites admins approved or rejected. */
export const trendingLinks: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        // Null until an admin decides, and then the website's decision, or the instance's default.
        await db.schema.alterTable("preview_cards").addColumn("trendable", "boolean").execute();

        await db.schema.createTable("preview_card_providers")
            .addColumn("domain", "text", (column) => column.primaryKey())
            .addColumn("trendable", "boolean", (column) => column.notNull())
            .execute();

        await db.schema.createTable("trending_links")
            .addColumn(
                "card_id",
                "text",
                (column) => column.primaryKey().references("preview_cards.id").onDelete("cascade"),
            )
            .addColumn("score", "double precision", (column) => column.notNull())
            .addColumn("max_score", "double precision", (column) => column.notNull())
            .addColumn("max_score_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("trending_links_by_score")
            .on("trending_links")
            .column("score")
            .execute();
    },
};
