import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Remote likes and dislikes, with their remote ids, so Deletes can undo them. */
export const remoteLikes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("likes")
            .addColumn("kind", "text", (column) => column.notNull().defaultTo("like"))
            .execute();
        await db.schema.alterTable("likes")
            .addColumn(
                "instance_id",
                "text",
                (column) => column.references("instances.id").onDelete("cascade"),
            )
            .execute();
        await db.schema.alterTable("likes").addColumn("remote_id", "text").execute();

        await db.schema.createIndex("likes_by_remote_id").on("likes")
            .unique()
            .columns(["instance_id", "remote_id"])
            .execute();
    },
};
