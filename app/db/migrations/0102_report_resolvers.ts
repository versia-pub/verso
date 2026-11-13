import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Reports keep who resolved them, through the admin API, and when a moderator last changed them, as
 * Mastodon's admin reports show.
 */
export const reportResolvers: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("reports")
            .addColumn(
                "resolved_by_account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("set null"),
            )
            .execute();
        await db.schema.alterTable("reports")
            .addColumn("updated_at", types.timestamp)
            .execute();
    },
};
