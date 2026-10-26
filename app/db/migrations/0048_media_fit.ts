import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The box a local image was scaled down to fit in, such as for an avatar. */
export const mediaFit: Migration = {
    up: async (db: Kysely<unknown>) => {
        // SQLite adds one column at a time.
        await db.schema.alterTable("media").addColumn("fit_width", "integer").execute();
        await db.schema.alterTable("media").addColumn("fit_height", "integer").execute();
    },
};
