import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** The accounts whose notifications users accepted, from their requests. */
export const notificationPermissions: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("notification_permissions")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn(
                "from_account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("notification_permissions_pkey", [
                "account_id",
                "from_account_id",
            ])
            .execute();
    },
};
