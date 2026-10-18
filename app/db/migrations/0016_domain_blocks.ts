import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const domainBlocks: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("domain_blocks")
            .addColumn("domain", "text", (column) => column.primaryKey())
            .addColumn("reason", "text", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
