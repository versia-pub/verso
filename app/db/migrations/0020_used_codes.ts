import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * When a flow's code was used, and the token it issued, so that a code used again, which may have
 * been stolen, revokes that token. Used flows are retained until they expire.
 */
export const usedCodes: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("oauth_flows").addColumn("code_used_at", types.timestamp)
            .execute();
        await db.schema.alterTable("oauth_flows").addColumn("token_id", "text").execute();
    },
};
