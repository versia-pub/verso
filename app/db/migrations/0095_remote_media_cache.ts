import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Remote media cached in the file store. The hash a remote instance gave for its media moves to its
 * own column, as `sha256` is now the key of the file Verso stores for it, with the type it is
 * served as.
 */
export const remoteMediaCache: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("media").addColumn("remote_sha256", "text").execute();
        await db.schema.alterTable("media").addColumn("cached_type", "text").execute();
        await sql`update media set remote_sha256 = sha256, sha256 = null
            where instance_id is not null`.execute(db);
    },
};
