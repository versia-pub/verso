import { PGlite } from "@electric-sql/pglite";
import { type Kysely, PGliteDialect, PostgresDialect, sql } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { connect, postgresPool } from "./database.ts";
import { migrate } from "./migrate.ts";
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

/** `db`, with every migration run. If they fail, it is closed. */
export const migrated = async <DB>(db: Kysely<DB>): Promise<Kysely<DB>> => {
    const result = await migrate(db);
    if (result.ok) return db;

    await db.destroy();
    throw result.error;
};

/** The data directory of a PGlite database with every migration run, made once per worker. */
let migratedPglite: Promise<Blob> | undefined;

const migratedPgliteData = () =>
    migratedPglite ??= (async () => {
        const pglite = await PGlite.create();
        const db = await migrated(connect(new PGliteDialect({ pglite })));
        try {
            return await pglite.dumpDataDir("none");
        } finally {
            await db.destroy();
        }
    })();

/**
 * A new database for one test, with every migration run. On PGlite, it is a copy of one migrated
 * once, since creating and migrating each takes several times as long, and more memory.
 */
export const migratedTestDatabase = async <DB>(): Promise<Kysely<DB>> => {
    if (testDatabaseKind !== "pglite") return await migrated(await testDatabase<DB>());

    const pglite = await PGlite.create({ loadDataDir: await migratedPgliteData() });
    return connect(new PGliteDialect({ pglite }));
};
