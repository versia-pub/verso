import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Remembers the local entities that were deleted, so fetching one answers `410 Gone`, and lets
 * queued deliveries of an entity be dropped once it is deleted: `delivery_bodies` gets the entity's
 * id and its author's local id. Bodies queued before this have neither, so deleting their entity
 * doesn't drop them. They expire within the delivery window (30 days at most), so nothing is
 * backfilled.
 */
export const deletedEntities: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("delivery_bodies").addColumn("entity_id", "text").execute();
        await db.schema.alterTable("delivery_bodies").addColumn("author_id", "text").execute();

        await db.schema.createIndex("delivery_bodies_by_entity").on("delivery_bodies")
            .column("entity_id")
            .execute();
        await db.schema.createIndex("delivery_bodies_by_author").on("delivery_bodies")
            .column("author_id")
            .execute();

        await db.schema.createTable("deleted_entities")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("type", "text", (column) => column.notNull())
            .addColumn("deleted_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("deleted_entities_by_deleted_at").on("deleted_entities")
            .column("deleted_at")
            .execute();
    },
};
