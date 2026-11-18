import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * A voter's ballot in a poll, which Versia sends as one Vote with all their choices. `poll_votes`
 * keeps a row for each choice. A ballot is made for each voter and poll that has votes, with the
 * oldest vote's id and time, and no `remote_id`, because Verso never stored the ids of Votes it
 * received.
 */
export const pollBallots: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        await db.schema.createTable("poll_ballots")
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
            .addColumn("remote_id", "text")
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .addColumn("updated_at", types.timestamp)
            .execute();

        await db.schema.createIndex("poll_ballots_by_voter").on("poll_ballots")
            .unique()
            .columns(["poll_id", "account_id"])
            .execute();
        await db.schema.createIndex("poll_ballots_by_account").on("poll_ballots")
            .column("account_id")
            .execute();
        await db.schema.createIndex("poll_ballots_by_remote_id").on("poll_ballots")
            .column("remote_id")
            .execute();

        await sql`
            insert into poll_ballots (id, poll_id, account_id, created_at)
            select min(id), poll_id, account_id, min(created_at)
            from poll_votes
            group by poll_id, account_id
        `.execute(db);
    },
};
