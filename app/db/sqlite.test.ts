import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("JSON that can't be read fails naming its column", async () => {
    const database = new DatabaseSync(":memory:");
    await using db = connect<{ things: { data: unknown } }>(sqliteDialect(database));

    await db.schema.createTable("things")
        .addColumn("data", columnTypes(db).json).execute();

    database.exec(`insert into things (data) values ('{"a":1}'), ('{broken')`);

    const error = await assertRejects(
        () => db.selectFrom("things").selectAll().execute(),
        Error,
        "The JSON in column data can't be read",
    );
    assert(error.cause instanceof SyntaxError);

    database.exec(`delete from things where data = '{broken'`);

    assertEquals(await db.selectFrom("things").selectAll().execute(), [{ data: { a: 1 } }]);
});

Deno.test("booleans are read as booleans and missing timestamps stay null", async () => {
    await using db = connect<{ flags: { on: boolean; at: Date | null } }>(
        sqliteDialect(new DatabaseSync(":memory:")),
    );

    await db.schema.createTable("flags")
        .addColumn("on", "boolean")
        .addColumn("at", columnTypes(db).timestamp).execute();

    await db.insertInto("flags").values([{ on: true, at: null }, { on: false, at: null }])
        .execute();

    assertEquals(
        await db.selectFrom("flags").selectAll().orderBy("on", "desc").execute(),
        [{ on: true, at: null }, { on: false, at: null }],
    );
});
