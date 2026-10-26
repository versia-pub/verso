import { type Kysely, type SelectQueryBuilder, sql, SqliteAdapter } from "kysely";

/**
 * Locks the rows a query selects until the transaction ends, skipping rows that another transaction
 * has locked, so concurrent workers never pick the same row. SQLite lets one writer in at a time,
 * so it needs neither.
 */
export const skippingLocked = <DB, TB extends keyof DB, O>(
    db: Kysely<DB>,
    query: SelectQueryBuilder<DB, TB, O>,
): SelectQueryBuilder<DB, TB, O> =>
    db.getExecutor().adapter instanceof SqliteAdapter ? query : query.forUpdate().skipLocked();

/**
 * Holds a lock on `key` until the transaction ends, so that transactions that take it for the same
 * key run one at a time, such as one that stores a file under a key and one that removes it. SQLite
 * lets one writer in at a time, and its transactions begin as writers, so it needs none.
 */
export const lockKey = async <DB>(db: Kysely<DB>, key: string): Promise<void> => {
    if (db.getExecutor().adapter instanceof SqliteAdapter) return;

    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
};
