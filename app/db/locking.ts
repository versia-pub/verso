import { type Kysely, type SelectQueryBuilder, SqliteAdapter } from "kysely";

/**
 * Locks the rows a query selects until the transaction ends, skipping rows that another
 * transaction has locked, so concurrent workers never pick the same row. SQLite lets one writer in
 * at a time, so it needs neither.
 */
export const skippingLocked = <DB, TB extends keyof DB, O>(
    db: Kysely<DB>,
    query: SelectQueryBuilder<DB, TB, O>,
): SelectQueryBuilder<DB, TB, O> =>
    db.getExecutor().adapter instanceof SqliteAdapter ? query : query.forUpdate().skipLocked();
