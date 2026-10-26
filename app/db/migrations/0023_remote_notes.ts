import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * What Verso stores about remote statuses: when each was last fetched or sent, so it is fetched
 * again once it is old, and the status each quotes.
 */
export const remoteNotes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notes").addColumn("fetched_at", columnTypes(db).timestamp)
            .execute();
        await db.schema.alterTable("notes")
            .addColumn(
                "quote_id",
                "text",
                (column) => column.references("notes.id").onDelete("set null"),
            )
            .execute();
    },
};
