import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Custom emojis, with their pictures in `media`, and the statuses and accounts that use them. */
export const emojis: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("emojis")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "instance_id",
                "text",
                (column) => column.references("instances.id").onDelete("cascade"),
            )
            .addColumn("shortcode", "text", (column) => column.notNull())
            .addColumn("media_id", "text", (column) => column.notNull().references("media.id"))
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        // An instance has one emoji per name, as on Mastodon.
        await db.schema.createIndex("emojis_by_shortcode").on("emojis")
            .unique()
            .columns(["instance_id", "shortcode"])
            .execute();

        await db.schema.createTable("note_emojis")
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().references("notes.id").onDelete("cascade"),
            )
            .addColumn(
                "emoji_id",
                "text",
                (column) => column.notNull().references("emojis.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("note_emojis_pkey", ["note_id", "emoji_id"])
            .execute();

        await db.schema.createTable("account_emojis")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "emoji_id",
                "text",
                (column) => column.notNull().references("emojis.id").onDelete("cascade"),
            )
            .addPrimaryKeyConstraint("account_emojis_pkey", ["account_id", "emoji_id"])
            .execute();
    },
};
