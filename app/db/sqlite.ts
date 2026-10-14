import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type Dialect, SqliteDialect } from "kysely";

/**
 * Runs Kysely on SQLite through Deno's built-in `node:sqlite`. Kysely's SQLite dialect expects
 * better-sqlite3, which has the same shape apart from how it tells whether a statement returns
 * rows. Closing Kysely closes the database.
 */
export const sqliteDialect = (database: DatabaseSync): Dialect =>
  new SqliteDialect({
    database: {
      close: () => database.close(),
      prepare: (sql) => {
        const statement = database.prepare(sql);
        const values = (parameters: readonly unknown[]) =>
          parameters as SQLInputValue[];
        return {
          reader: statement.columns().length > 0,
          all: (parameters) => statement.all(...values(parameters)),
          run: (parameters) => statement.run(...values(parameters)),
          iterate: (parameters) => statement.iterate(...values(parameters)),
        };
      },
    },
  });
