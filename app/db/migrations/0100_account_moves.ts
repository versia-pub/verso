import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Where accounts moved from and to: the account each says it moved from, which an account that
 * moved to it is checked against, and the account each moved to, and when.
 */
export const accountMoves: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.alterTable("accounts")
            .addColumn("previous_host", "text")
            .execute();
        await db.schema.alterTable("accounts")
            .addColumn("previous_id", "text")
            .execute();
        await db.schema.alterTable("accounts")
            .addColumn(
                "moved_to_account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("set null"),
            )
            .execute();
        await db.schema.alterTable("accounts")
            .addColumn("moved_at", types.timestamp)
            .execute();
        // For keeping the accounts moved to from being pruned.
        await db.schema.createIndex("accounts_by_moved_to").on("accounts")
            .column("moved_to_account_id")
            .execute();
    },
};
