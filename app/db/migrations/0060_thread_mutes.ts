import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * The thread each status is in, as the id of the status that starts it, and the threads that users
 * mute. Existing statuses are put in the thread of the status they reply to, as far as Verso has
 * it.
 */
export const threadMutes: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notes")
            .addColumn("thread_id", "text", (column) => column.notNull().defaultTo(""))
            .execute();

        await sql`update notes set thread_id = id`.execute(db);
        await sql`
            with recursive threads(id, thread_id) as (
                select id, id from notes where in_reply_to_id is null
                union all
                select notes.id, threads.thread_id
                from notes join threads on notes.in_reply_to_id = threads.id
            )
            update notes set thread_id = threads.thread_id
            from threads
            where threads.id = notes.id and notes.in_reply_to_id is not null
        `.execute(db);

        await db.schema.createTable("thread_mutes")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("thread_id", "text", (column) => column.notNull())
            .addColumn("created_at", columnTypes(db).timestamp, (column) => column.notNull())
            .execute();

        await db.schema.createIndex("thread_mutes_by_pair").on("thread_mutes")
            .unique()
            .columns(["account_id", "thread_id"])
            .execute();
    },
};
