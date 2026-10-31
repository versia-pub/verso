import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** Polls on statuses, their options and votes, and the options a status had before each edit. */
export const polls: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("polls")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "note_id",
                "text",
                (column) => column.notNull().unique().references("notes.id").onDelete("cascade"),
            )
            .addColumn("multiple", "boolean", (column) => column.notNull())
            .addColumn("hide_totals", "boolean", (column) => column.notNull())
            .addColumn("expires_at", types.timestamp)
            .addColumn("voters_count", "integer")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createTable("poll_options")
            .addColumn(
                "poll_id",
                "text",
                (column) => column.notNull().references("polls.id").onDelete("cascade"),
            )
            .addColumn("position", "integer", (column) => column.notNull())
            .addColumn("title", "text", (column) => column.notNull())
            .addColumn("votes_count", "integer", (column) => column.notNull().defaultTo(0))
            .addPrimaryKeyConstraint("poll_options_pkey", ["poll_id", "position"])
            .execute();

        await db.schema.createTable("poll_votes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "poll_id",
                "text",
                (column) => column.notNull().references("polls.id").onDelete("cascade"),
            )
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("choice", "integer", (column) => column.notNull())
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("poll_votes_by_voter").on("poll_votes")
            .unique()
            .columns(["poll_id", "account_id", "choice"])
            .execute();

        await db.schema.createIndex("poll_votes_by_account").on("poll_votes")
            .column("account_id")
            .execute();

        await db.schema.alterTable("note_versions")
            .addColumn("poll_options", types.json)
            .execute();
    },
};
