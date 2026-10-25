import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Since when instances couldn't be reached, so that nothing is sent to one down too long. */
export const unreachableSince: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("instances")
            .addColumn("unreachable_since", columnTypes(db).timestamp)
            .execute();
    },
};
