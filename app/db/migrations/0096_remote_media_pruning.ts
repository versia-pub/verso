import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Remote media by when it was cached, so the files of old attachments can be pruned. */
export const remoteMediaPruning: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("media_remote_by_cache").on("media")
            .column("processed_at")
            .where(sql<boolean>`instance_id is not null`)
            .execute();
    },
};
