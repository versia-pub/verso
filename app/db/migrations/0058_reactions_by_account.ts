import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * An account's reactions by status, so that those of the accounts someone blocks are found from
 * them, as `likes_by_pair` finds their likes. It still serves deleting an account's reactions.
 */
export const reactionsByAccount: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.dropIndex("reactions_by_account").execute();
        await db.schema.createIndex("reactions_by_account").on("reactions")
            .columns(["account_id", "note_id"])
            .execute();
    },
};
