import { assertEquals } from "@std/assert";
import { sql } from "kysely";
import { openDatabase, postgresPool } from "./database.ts";

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
    });
});

Deno.test("a postgres connection failing while idle doesn't end the process", async () => {
    const pool = postgresPool("postgresql://nowhere.invalid/verso");

    // With no listener, emitting an error throws it.
    pool.emit("error", new Error("Connection terminated unexpectedly"));
    await pool.end();
});
