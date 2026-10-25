import { assertEquals, assertRejects } from "@std/assert";
import { type Kysely, sql } from "kysely";
import { type Database, openDatabase, postgresPool } from "./database.ts";
import { testDatabaseKind, testPostgresUrl } from "./testing.ts";

Deno.test("a sqlite config opens that database", async () => {
    await using db = openDatabase({ sqlite: ":memory:" });

    const { rows } = await sql<{ answer: number }>`select 42 as answer`
        .execute(db);

    assertEquals(rows, [{ answer: 42 }]);
});

Deno.test("sqlite waits for another writer instead of failing at once", async () => {
    await using db = openDatabase({ sqlite: ":memory:" });

    const { rows } = await sql<{ timeout: number }>`pragma busy_timeout`.execute(db);

    assertEquals(rows, [{ timeout: 5000 }]);
});

Deno.test("a postgres config doesn't connect until the first query", async () => {
    await using _db = openDatabase({
        postgres: "postgresql://nowhere.invalid/verso",
        pool_size: 30,
        connect_timeout_seconds: 10,
        statement_timeout_seconds: 60,
    });
});

Deno.test("a postgres connection failing while idle doesn't end the process", async () => {
    const pool = postgresPool("postgresql://nowhere.invalid/verso");

    // With no listener, emitting an error throws it.
    pool.emit("error", new Error("Connection terminated unexpectedly"));
    await pool.end();
});

Deno.test({
    name: "on Postgres, queries are held to the configured time, but migrations aren't",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        const url = await testPostgresUrl();
        if (!url) return;
        const config = {
            postgres: url,
            pool_size: 2,
            connect_timeout_seconds: 10,
            statement_timeout_seconds: 5,
        };
        const timeouts = async (db: Kysely<Database>) =>
            (await sql<{ statement: string; idle: string }>`select
                current_setting('statement_timeout') as statement,
                current_setting('idle_in_transaction_session_timeout') as idle`.execute(db)).rows;

        await using db = openDatabase(config);
        await using migrating = openDatabase(config, { forMigrations: true });

        assertEquals(await timeouts(db), [{ statement: "5s", idle: "5s" }]);
        assertEquals(await timeouts(migrating), [{ statement: "0", idle: "0" }]);
    },
});

Deno.test({
    name:
        "on Postgres, a process has at most the configured connections, and waits so long for one",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        const url = await testPostgresUrl();
        if (!url) return;
        await using db = openDatabase({
            postgres: url,
            pool_size: 1,
            connect_timeout_seconds: 1,
            statement_timeout_seconds: 60,
        });

        let release = () => {};
        const held = new Promise<void>((resolve) => release = resolve);
        const holding = db.transaction().execute(() => held);

        await assertRejects(() => sql`select 1`.execute(db), Error, "timeout");
        release();
        await holding;
    },
});
