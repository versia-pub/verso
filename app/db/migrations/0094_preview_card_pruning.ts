import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Preview cards by when their page was fetched, so the old ones can be pruned. */
export const previewCardPruning: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("preview_cards_by_fetch").on("preview_cards")
            .columns(["fetched_at", "id"])
            .execute();
    },
};
