import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { usesSqlite } from "../columns.ts";

/**
 * Each hashtag's statuses in id order, read without going to `note_tags` itself, and hashtags by
 * how they start. On PostgreSQL, `text_pattern_ops` compares bytes, so a prefix is a range of the
 * index under any collation; SQLite's indexes already do.
 */
export const hashtagIndexes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.dropIndex("note_tags_by_name").execute();

        if (usesSqlite(db)) {
            await db.schema.createIndex("note_tags_by_name").on("note_tags")
                .columns(["name", "note_id"])
                .execute();
            return;
        }

        await sql`CREATE INDEX note_tags_by_name ON note_tags (name text_pattern_ops, note_id)`
            .execute(db);
    },
};
