import { assertEquals } from "@std/assert";
import { sql } from "kysely";
import { openDatabase } from "./database.ts";

Deno.test("a sqlite config opens that database", async () => {
    await using db = openDatabase({ sqlite: ":memory:" });

    const { rows } = await sql<{ answer: number }>`select 42 as answer`
        .execute(db);

    assertEquals(rows, [{ answer: 42 }]);
});

Deno.test("a postgres config doesn't connect until the first query", async () => {
    await using _db = openDatabase({
        postgres: "postgresql://nowhere.invalid/verso",
    });
});
