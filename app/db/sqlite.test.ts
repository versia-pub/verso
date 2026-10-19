import { assertEquals } from "@std/assert";
import { sql } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { columnTypes } from "./columns.ts";
import { connect } from "./database.ts";
import { sqliteDialect } from "./sqlite.ts";

// PGlite can't stream, so this one is SQLite only.
Deno.test("streamed rows have their timestamps read as Date", async () => {
    await using db = connect<{ events: { at: Date } }>(
        sqliteDialect(new DatabaseSync(":memory:")),
    );

    await db.schema.createTable("events")
        .addColumn("at", columnTypes(db).timestamp).execute();

    const at = new Date("2026-10-15T12:34:56.789Z");
    await db.insertInto("events").values({ at }).execute();

    assertEquals(
        await Array.fromAsync(db.selectFrom("events").selectAll().stream()),
        [{ at }],
    );
});

Deno.test("a transaction takes the write lock as it begins", async () => {
    const database = new DatabaseSync(":memory:");
    const statements: string[] = [];
    // Only what the dialect uses, recording each statement.
    const recorded = {
        prepare: (sql: string) => {
            statements.push(sql);
            return database.prepare(sql);
        },
        close: () => database.close(),
    } as unknown as DatabaseSync;
    await using db = connect(sqliteDialect(recorded));

    await db.transaction().execute((tx) => sql`select 1`.execute(tx));

    assertEquals(statements, ["begin immediate", "select 1", "commit"]);
});
