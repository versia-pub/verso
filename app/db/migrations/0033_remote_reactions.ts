import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Remote reactions, with their remote ids, so Deletes can undo them. */
export const remoteReactions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("reactions")
            .addColumn(
                "instance_id",
                "text",
                (column) => column.references("instances.id").onDelete("cascade"),
            )
            .execute();
        await db.schema.alterTable("reactions").addColumn("remote_id", "text").execute();

        await db.schema.createIndex("reactions_by_remote_id").on("reactions")
            .unique()
            .columns(["instance_id", "remote_id"])
            .execute();
    },
};
