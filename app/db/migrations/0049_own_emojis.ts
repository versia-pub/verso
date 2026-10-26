import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Local emojis that belong to a user rather than to everyone, and the picker's group of each.
 * Everyone's have one per name, and each user's have one per name, but a user's may share a name
 * with another user's or with everyone's.
 */
export const ownEmojis: Migration = {
    up: async (db: Kysely<unknown>) => {
        // SQLite adds one column at a time.
        await db.schema.alterTable("emojis")
            .addColumn(
                "account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("cascade"),
            )
            .execute();
        await db.schema.alterTable("emojis").addColumn("category", "text").execute();

        await db.schema.dropIndex("local_emojis_by_shortcode").execute();
        await db.schema.createIndex("global_emojis_by_shortcode").on("emojis")
            .unique()
            .column("shortcode")
            .where(sql<boolean>`instance_id is null and account_id is null`)
            .execute();
        // Also the index deleting an account's emojis goes through.
        await db.schema.createIndex("own_emojis_by_shortcode").on("emojis")
            .unique()
            .columns(["account_id", "shortcode"])
            .where(sql<boolean>`account_id is not null`)
            .execute();
    },
};
