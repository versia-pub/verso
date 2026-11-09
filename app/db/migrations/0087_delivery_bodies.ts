import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * The entities queued for delivery, each stored once however many instances it goes to, so a
 * delivery job holds only its id.
 */
export const deliveryBodies: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("delivery_bodies")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("body", "text", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("delivery_bodies_created_at").on("delivery_bodies")
            .column("created_at")
            .execute();
    },
};
