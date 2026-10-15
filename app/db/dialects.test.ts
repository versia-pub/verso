import { assertEquals, assertRejects } from "@std/assert";
import { sql } from "kysely";
import { columnTypes } from "./columns.ts";
import { testDatabase, testDatabaseKind } from "./testing.ts";

type Database = {
    notes: { id: number; text: string };
    events: { id: number; at: Date | null };
    documents: { id: number; doc: unknown; flag: boolean | null };
};

const open = async () => {
    const db = await testDatabase<Database>();

    await db.schema.createTable("notes")
        .addColumn("id", "integer", (column) => column.primaryKey())
        .addColumn("text", "text", (column) => column.notNull())
        .execute();

    await db.schema.createTable("events")
        .addColumn("id", "integer", (column) => column.primaryKey())
        .addColumn("at", columnTypes(db).timestamp)
        .execute();

    await db.schema.createTable("documents")
        .addColumn("id", "integer", (column) => column.primaryKey())
        .addColumn("doc", columnTypes(db).json)
        .addColumn("flag", "boolean")
        .execute();

    return db;
};

Deno.test("queries run", async () => {
    await using db = await open();
    const inserted = await db.insertInto("notes")
        .values([{ id: 1, text: "one" }, { id: 2, text: "two" }])
        .executeTakeFirst();

    assertEquals(inserted.numInsertedOrUpdatedRows, 2n);

    assertEquals(
        await db.selectFrom("notes").select("text").orderBy("id").execute(),
        [{ text: "one" }, { text: "two" }],
    );
});

Deno.test("writes can return rows", async () => {
    await using db = await open();
    assertEquals(
        await db.insertInto("notes").values({ id: 1, text: "one" })
            .returning(["id", "text"]).execute(),
        [{ id: 1, text: "one" }],
    );
});

Deno.test("a failed transaction leaves nothing behind", async () => {
    await using db = await open();
    await assertRejects(
        () =>
            db.transaction().execute(async (tx) => {
                await tx.insertInto("notes").values({ id: 1, text: "one" })
                    .execute();
                throw new Error("oops");
            }),
        Error,
        "oops",
    );

    assertEquals(await db.selectFrom("notes").selectAll().execute(), []);
});

Deno.test("queries outside a transaction don't see its writes", async () => {
    await using db = await open();

    let inserted = () => {};
    const hasInserted = new Promise<void>((resolve) => inserted = resolve);

    const transaction = assertRejects(() =>
        db.transaction().execute(async (tx) => {
            await tx.insertInto("notes").values({ id: 1, text: "one" })
                .execute();
            inserted();
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("rolled back");
        })
    );

    await hasInserted;

    // With one connection, a query that slipped into the transaction would see the row.
    assertEquals(await db.selectFrom("notes").selectAll().execute(), []);

    await transaction;
});

Deno.test("timestamps come back as the same Date", async () => {
    await using db = await open();

    const at = new Date("2026-10-15T12:34:56.789Z");
    assertEquals(
        await db.insertInto("events").values({ id: 1, at }).returning("at")
            .execute(),
        [{ at }],
    );

    await db.insertInto("events").values({ id: 2, at: null }).execute();

    assertEquals(
        await db.selectFrom("events").select(["id", "at"]).orderBy("id")
            .execute(),
        [{ id: 1, at }, { id: 2, at: null }],
    );
});

Deno.test("timestamps sort and compare in time order", async () => {
    await using db = await open();

    const times = [
        "2026-10-15T12:00:00.000Z",
        "1999-12-31T23:59:59.999Z",
        "2026-10-15T12:00:00.001Z",
        "2026-10-15T11:59:59.000Z",
        "2100-01-01T00:00:00.000Z",
    ].map((time) => new Date(time));

    await db.insertInto("events")
        .values(times.map((at, id) => ({ id, at })))
        .execute();

    const sorted = await db.selectFrom("events").select("at").orderBy("at")
        .execute();

    assertEquals(
        sorted.map((row) => row.at),
        times.toSorted((a, b) => a.getTime() - b.getTime()),
    );

    const later = await db.selectFrom("events").select("id")
        .where("at", ">", times[0]).orderBy("id").execute();

    assertEquals(later, [{ id: 2 }, { id: 4 }]);
});

Deno.test("JSON objects and arrays come back as written", async () => {
    await using db = await open();

    const docs = [
        { a: [1, "two", null, { b: true }], c: "\u00e9" },
        [1, [2, 3], { d: [] }],
        [],
        {},
    ];

    await db.insertInto("documents")
        .values(docs.map((doc, id) => ({ id, doc, flag: null })))
        .execute();
    await db.insertInto("documents")
        .values({ id: docs.length, doc: null, flag: null })
        .execute();

    assertEquals(
        await db.selectFrom("documents").select("doc").orderBy("id").execute(),
        [...docs, null].map((doc) => ({ doc })),
    );

    // Stored as JSON, not as a JSON string or a Postgres array.
    const typeOf = sql.raw(
        testDatabaseKind === "sqlite" ? "json_type" : "jsonb_typeof",
    );

    assertEquals(
        await db.selectFrom("documents")
            .select(sql<string>`${typeOf}(doc)`.as("type"))
            .where("doc", "is not", null).orderBy("id").execute(),
        ["object", "array", "array", "object"].map((type) => ({ type })),
    );
});

Deno.test("booleans come back as booleans", async () => {
    await using db = await open();

    await db.insertInto("documents").values([
        { id: 1, doc: null, flag: true },
        { id: 2, doc: null, flag: false },
        { id: 3, doc: null, flag: null },
    ]).execute();

    assertEquals(
        await db.selectFrom("documents").select("flag").orderBy("id").execute(),
        [{ flag: true }, { flag: false }, { flag: null }],
    );

    assertEquals(
        await db.selectFrom("documents").select("id").where("flag", "=", true)
            .execute(),
        [{ id: 1 }],
    );
});
