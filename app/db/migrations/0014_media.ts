import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

export const media: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("media")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("instance_id", "text", (column) => column.references("instances.id"))
            .addColumn("url", "text")
            .addColumn("media_type", "text", (column) => column.notNull())
            .addColumn("size", "integer")
            .addColumn("sha256", "text")
            .addColumn("width", "integer")
            .addColumn("height", "integer")
            .addColumn("thumbhash", "text")
            .addColumn("description", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();
    },
};
