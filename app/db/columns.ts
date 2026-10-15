import { type Expression, type Kysely, sql, SqliteAdapter } from "kysely";

/**
 * The type names SQLite columns are declared with, so the SQLite dialect knows which values to
 * convert when reading. Each contains "text", which makes SQLite store values as text as given.
 */
export const sqliteTypes = {
    timestamp: "timestamp_text",
    json: "json_text",
} as const;

/**
 * Column types for migrations. These are the only place where the schema differs between
 * databases.
 */
export const columnTypes = <DB>(
    db: Kysely<DB>,
): { timestamp: Expression<unknown>; json: Expression<unknown> } => {
    const sqlite = db.getExecutor().adapter instanceof SqliteAdapter;

    return {
        /**
         * A point in time, read as a `Date`: `timestamptz` on Postgres, ISO 8601 text on SQLite.
         * Values must come from the Clock, never from `now()` or `current_timestamp` column
         * defaults: SQLite writes those in a different format, which breaks reading and ordering.
         */
        timestamp: sql.raw(sqlite ? sqliteTypes.timestamp : "timestamptz"),

        /**
         * A JSON object or array, read back as one: `jsonb` on Postgres, text on SQLite. Bare
         * strings, numbers and booleans aren't allowed at the top level, since they aren't sent as
         * JSON.
         */
        json: sql.raw(sqlite ? sqliteTypes.json : "jsonb"),
    };
};
