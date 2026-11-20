import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Remembers the subscribers of a remote account that moved to a local one, as references, since
 * most of them aren't known to Verso. The local account accepts their Subscribes for 30 days.
 */
export const moveSubscribers: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("move_subscribers")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("host", "text", (column) => column.notNull())
            .addColumn("remote_id", "text", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("move_subscribers_pkey", ["account_id", "host", "remote_id"])
            .execute();

        await db.schema.createIndex("move_subscribers_by_created_at").on("move_subscribers")
            .column("created_at")
            .execute();
    },
};
