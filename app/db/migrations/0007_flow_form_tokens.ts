import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const flowFormTokens: Migration = {
    up: async (db: Kysely<unknown>) => {
        // Flows started before this have none, so their forms are rejected and the user starts
        // over.
        await db.schema.alterTable("oauth_flows").addColumn("form_token", "text").execute();
    },
};
