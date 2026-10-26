import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The local instance's emojis, one per name, as remote instances' emojis are, and indexes for the
 * columns rows are deleted through, so deleting an emoji or a picture doesn't scan every row that
 * might reference it.
 */
export const localEmojis: Migration = {
    up: async (db: Kysely<unknown>) => {
        // The index by instance and name doesn't hold for this one, as no two nulls are the same.
        await db.schema.createIndex("local_emojis_by_shortcode").on("emojis")
            .unique()
            .column("shortcode")
            .where(sql<boolean>`instance_id is null`)
            .execute();

        await db.schema.createIndex("emojis_by_media").on("emojis").column("media_id").execute();
        await db.schema.createIndex("note_emojis_by_emoji").on("note_emojis")
            .column("emoji_id")
            .execute();
        await db.schema.createIndex("account_emojis_by_emoji").on("account_emojis")
            .column("emoji_id")
            .execute();
    },
};
