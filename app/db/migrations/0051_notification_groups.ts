import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The group each notification is in, for grouped notifications, if its type is grouped. */
export const notificationGroups: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notifications").addColumn("group_key", "text").execute();

        // For a group's notifications, and the latest group of a kind.
        await db.schema.createIndex("notifications_by_group").on("notifications")
            .columns(["account_id", "group_key", "id"])
            .execute();
    },
};
