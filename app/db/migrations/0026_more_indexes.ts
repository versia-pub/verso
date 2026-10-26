import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Indexes for paging through follow lists and replies in order, and for the columns rows are
 * deleted or nulled through, so deleting an account, a picture, an app or an instance doesn't scan
 * every row that might reference it.
 */
export const moreIndexes: Migration = {
    up: async (db: Kysely<unknown>) => {
        // Pages of a list are read in order of the follows' ids, rather than sorted every time.
        await db.schema.dropIndex("follows_by_followee").execute();
        await db.schema.createIndex("follows_by_followee").on("follows")
            .columns(["followee_id", "accepted", "id"])
            .execute();
        await db.schema.createIndex("follows_by_follower").on("follows")
            .columns(["follower_id", "accepted", "id"])
            .execute();

        await db.schema.dropIndex("notes_by_reply").execute();
        await db.schema.createIndex("notes_by_reply").on("notes")
            .columns(["in_reply_to_id", "id"])
            .execute();

        const references = [
            ["accounts", "avatar_id"],
            ["accounts", "header_id"],
            ["notes", "in_reply_to_account_id"],
            ["media", "instance_id"],
            ["access_tokens", "app_id"],
            ["oauth_flows", "app_id"],
            ["oauth_flows", "account_id"],
        ];
        for (const [table, column] of references) {
            await db.schema.createIndex(`${table}_by_${column}`).on(table).column(column).execute();
        }

        // For deleting the jobs retained after they finished, once their time is up.
        await db.schema.createIndex("jobs_by_keep_until").on("jobs").column("keep_until").execute();
    },
};
