import { type Kysely, sql, SqliteAdapter } from "kysely";

/**
 * Sends a Postgres notification to everyone listening on `channel`. Inside a transaction it is
 * delivered only on commit, and not at all on rollback. SQLite has no notifications, so this does
 * nothing there.
 */
export const notify = async <DB>(
    db: Kysely<DB>,
    channel: string,
    payload: string,
): Promise<void> => {
    if (db.getExecutor().adapter instanceof SqliteAdapter) return;
    await sql`select pg_notify(${channel}, ${payload})`.execute(db);
};
