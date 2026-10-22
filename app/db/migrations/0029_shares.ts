import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Shares, which Mastodon calls reblogs: notes that share another, and go with it. Each note counts
 * its shares.
 */
export const shares: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notes")
            .addColumn(
                "reblog_of_id",
                "text",
                (column) => column.references("notes.id").onDelete("cascade"),
            )
            .execute();
        await db.schema.alterTable("notes")
            .addColumn("shares_count", "integer", (column) => column.notNull().defaultTo(0))
            .execute();

        // An account shares a note once. Notes that aren't shares have no `reblog_of_id`, and so
        // don't clash.
        await db.schema.createIndex("notes_by_share").on("notes")
            .unique()
            .columns(["account_id", "reblog_of_id"])
            .execute();

        // For the shares of a note, newest first, and for deleting them with it.
        await db.schema.createIndex("notes_by_reblog").on("notes")
            .columns(["reblog_of_id", "id"])
            .execute();
    },
};
