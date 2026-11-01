import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/** When each poll was seen to end, so its voters are told once. */
export const endedPolls: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("polls")
            .addColumn("ended_at", columnTypes(db).timestamp)
            .execute();

        // For finding the polls that have ended since, which are few.
        await db.schema.createIndex("polls_ending").on("polls")
            .column("expires_at")
            .where(sql<boolean>`ended_at is null`)
            .execute();
    },
};
