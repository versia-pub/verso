import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type Dialect, SqliteAdapter, SqliteDialect } from "kysely";
import { sqliteTypes } from "./columns.ts";

const write = (value: unknown) =>
    value instanceof Date
        ? value.toISOString()
        : typeof value === "boolean"
        ? Number(value)
        : value;

const readers: Record<string, (value: unknown) => unknown> = {
    [sqliteTypes.timestamp]: (value) => new Date(value as string),
    [sqliteTypes.json]: (value) => JSON.parse(value as string),
    boolean: (value) => value !== 0,
};

/**
 * Kysely assumes SQLite can't undo schema changes in a rolled-back transaction, but it can, so
 * migrations get a transaction here too. `PRAGMA foreign_keys` can't change inside one, though,
 * so a migration that rebuilds a table uses `PRAGMA defer_foreign_keys` instead.
 */
class TransactionalSqliteAdapter extends SqliteAdapter {
    override get supportsTransactionalDdl(): boolean {
        return true;
    }
}

class NodeSqliteDialect extends SqliteDialect {
    override createAdapter(): SqliteAdapter {
        return new TransactionalSqliteAdapter();
    }
}

/**
 * Runs Kysely on SQLite through Deno's built-in `node:sqlite`. Kysely's SQLite dialect expects
 * better-sqlite3, which has the same shape apart from how it tells whether a statement returns
 * rows. Closing Kysely closes the database.
 *
 * SQLite has no date, JSON or boolean types. Dates are written as ISO 8601 text and booleans as
 * 1 or 0 (JSON arrives as text from the `jsonValues` plugin). Reading converts them back, going by
 * each column's declared type.
 */
export const sqliteDialect = (database: DatabaseSync): Dialect =>
    new NodeSqliteDialect({
        database: {
            close: () => database.close(),
            prepare: (sql) => {
                const statement = database.prepare(sql);
                const columns = statement.columns();
                const converted = columns.flatMap((column) => {
                    const convert = column.type &&
                        readers[column.type.toLowerCase()];
                    return convert ? [[column.name, convert] as const] : [];
                });
                const values = (parameters: readonly unknown[]) =>
                    parameters.map(write) as SQLInputValue[];
                const read = (row: unknown) => {
                    const record = row as Record<string, unknown>;
                    for (const [name, convert] of converted) {
                        if (record[name] !== null) {
                            record[name] = convert(record[name]);
                        }
                    }
                    return record;
                };
                return {
                    reader: columns.length > 0,
                    all: (parameters) => statement.all(...values(parameters)).map(read),
                    run: (parameters) => statement.run(...values(parameters)),
                    iterate: (parameters) => statement.iterate(...values(parameters)).map(read),
                };
            },
        },
    });
