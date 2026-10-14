import { PGlite } from "@electric-sql/pglite";
import { type Kysely, PGliteDialect, PostgresDialect, sql } from "kysely";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { connect } from "./database.ts";
import { sqliteDialect } from "./sqlite.ts";

/**
 * The database tests run on, chosen by `VERSO_TEST_DATABASE`: `pglite` (the default), `sqlite`,
 * or the URL of a PostgreSQL server that tests may create databases on.
 */
export const testDatabaseKind: string = Deno.env.get("VERSO_TEST_DATABASE") ??
    "pglite";

const postgresPool = (url: string) =>
    new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) });

/** A new, empty database for one test. */
export const testDatabase = async <DB>(): Promise<Kysely<DB>> => {
    if (testDatabaseKind === "pglite") {
        return connect(new PGliteDialect({ pglite: await PGlite.create() }));
    }
    if (testDatabaseKind === "sqlite") {
        return connect(sqliteDialect(new DatabaseSync(":memory:")));
    }
    const url = new URL(testDatabaseKind);
    const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await using server = connect(postgresPool(url.href));
    await sql`create database ${sql.id(name)}`.execute(server);
    url.pathname = `/${name}`;
    return connect(postgresPool(url.href));
};
