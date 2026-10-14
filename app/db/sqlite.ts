import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type Dialect, SqliteDialect } from "kysely";
import { sqliteTypes } from "./columns.ts";

/**
 * Runs Kysely on SQLite through Deno's built-in `node:sqlite`. Kysely's SQLite dialect expects
 * better-sqlite3, which has the same shape apart from how it tells whether a statement returns
 * rows. Closing Kysely closes the database.
 *
 * SQLite has no date type, so dates are written as ISO 8601 text and read back as `Date` from
 * columns declared with the `timestamp` helper.
 */
export const sqliteDialect = (database: DatabaseSync): Dialect =>
  new SqliteDialect({
    database: {
      close: () => database.close(),
      prepare: (sql) => {
        const statement = database.prepare(sql);
        const columns = statement.columns();
        const timestamps = columns
          .filter((column) => column.type === sqliteTypes.timestamp)
          .map((column) => column.name);
        const values = (parameters: readonly unknown[]) =>
          parameters.map((value) =>
            value instanceof Date ? value.toISOString() : value
          ) as SQLInputValue[];
        const read = (row: unknown) => {
          const record = row as Record<string, unknown>;
          for (const name of timestamps) {
            const value = record[name];
            if (typeof value === "string") record[name] = new Date(value);
          }
          return record;
        };
        return {
          reader: columns.length > 0,
          all: (parameters) => statement.all(...values(parameters)).map(read),
          run: (parameters) => statement.run(...values(parameters)),
          iterate: (parameters) =>
            statement.iterate(...values(parameters)).map(read),
        };
      },
    },
  });
