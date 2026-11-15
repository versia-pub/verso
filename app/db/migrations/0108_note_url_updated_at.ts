import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * A remote status's web page, as its Note's `url` gave it, and its `updated_at` as received, so a
 * Note version older than the held one is discarded. Both are `null` for local statuses, whose
 * edits are `edited_at`, and where the Note gave none.
 */
export const noteUrlUpdatedAt: Migration = {
    up: async (db: Kysely<unknown>) => {
        // One at a time, since SQLite adds only one column per statement.
        await db.schema.alterTable("notes").addColumn("url", "text").execute();
        await db.schema.alterTable("notes")
            .addColumn("updated_at", columnTypes(db).timestamp)
            .execute();
    },
};
