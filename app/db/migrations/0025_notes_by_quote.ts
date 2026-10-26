import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** For the statuses that quote a status, as its `quotes` collection lists them. */
export const notesByQuote: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("notes_by_quote").on("notes")
            .columns(["quote_id", "id"])
            .execute();
    },
};
