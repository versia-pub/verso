import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Remote accounts by when they were last fetched, so the old ones can be pruned without reading the
 * rest, and the notification requests and permissions by the account they are from, which keep one.
 */
export const remoteAccountPruning: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createIndex("accounts_remote_by_fetch").on("accounts")
            .columns(["fetched_at", "id"])
            .where(sql<boolean>`instance_id is not null`)
            .execute();
        await db.schema.createIndex("notification_requests_by_sender").on("notification_requests")
            .column("from_account_id")
            .execute();
        await db.schema.createIndex("notification_permissions_by_sender")
            .on("notification_permissions")
            .column("from_account_id")
            .execute();
    },
};
