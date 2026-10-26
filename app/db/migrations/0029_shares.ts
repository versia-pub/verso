import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Boosts (Mastodon calls them reblogs, Versia calls them Shares): statuses that boost another, and
 * are deleted with it. Each status counts its boosts.
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

        // An account boosts a status once. Statuses that aren't boosts have no `reblog_of_id`, and
        // so don't clash.
        await db.schema.createIndex("notes_by_share").on("notes")
            .unique()
            .columns(["account_id", "reblog_of_id"])
            .execute();

        // For the boosts of a status, newest first, and for deleting them with it.
        await db.schema.createIndex("notes_by_reblog").on("notes")
            .columns(["reblog_of_id", "id"])
            .execute();
    },
};
