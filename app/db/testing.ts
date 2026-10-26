import { PGlite } from "@electric-sql/pglite";
import { type Kysely, PGliteDialect, PostgresDialect, sql } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { connect, postgresPool } from "./database.ts";
import { sqliteDialect } from "./sqlite.ts";

/**
 * The database tests run on, chosen by `VERSO_TEST_DATABASE`: `pglite` (the default), `sqlite`, or
 * the URL of a PostgreSQL server that tests may create databases on.
 */
export const testDatabaseKind: string = Deno.env.get("VERSO_TEST_DATABASE") ??
    "pglite";

const postgresDialect = (url: string) => new PostgresDialect({ pool: postgresPool(url) });

/** The URL of a new, empty PostgreSQL database, or `undefined` when tests run in-process. */
export const testPostgresUrl = async (): Promise<string | undefined> => {
    if (testDatabaseKind === "pglite" || testDatabaseKind === "sqlite") return undefined;

    const url = new URL(testDatabaseKind);
    const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;

    await using server = connect(postgresDialect(url.href));
    await sql`create database ${sql.id(name)}`.execute(server);

    url.pathname = `/${name}`;
    return url.href;
};

/** A new, empty database for one test. */
export const testDatabase = async <DB>(): Promise<Kysely<DB>> => {
    const postgres = await testPostgresUrl();

    if (postgres) return connect(postgresDialect(postgres));

    if (testDatabaseKind === "sqlite") return connect(sqliteDialect(new DatabaseSync(":memory:")));

    return connect(new PGliteDialect({ pglite: await PGlite.create() }));
};
