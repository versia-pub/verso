import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Kysely, sql } from "kysely";
import { checkForeignKeys } from "./columns.ts";
import { firstMigratedAt, migrate } from "./migrate.ts";
import { testDatabase, testDatabaseKind } from "./testing.ts";

const createNotes = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("notes")
            .addColumn("id", "integer", (column) => column.primaryKey())
            .execute();
    },
};

const addText = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.alterTable("notes").addColumn("text", "text").execute();
    },
};

const failing = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("half_done").addColumn("id", "integer")
            .execute();

        await sql`not sql`.execute(db);
    },
};

const tables = async (db: Kysely<unknown>) =>
    (await db.introspection.getTables())
        .map((table) => table.name)
        .filter((name) => !name.startsWith("kysely_"))
        .toSorted();

Deno.test("migrations run in name order, once each", async () => {
    await using db = await testDatabase();

    assertEquals(
        await migrate(db, {
            "0002_add_text": addText,
            "0001_notes": createNotes,
        }),
        { ok: true, applied: ["0001_notes", "0002_add_text"] },
    );

    assertEquals(
        await migrate(db, {
            "0001_notes": createNotes,
            "0002_add_text": addText,
        }),
        { ok: true, applied: [] },
    );

    assertEquals(await tables(db), ["notes"]);
});

Deno.test("if one migration fails, none are applied", async () => {
    await using db = await testDatabase();

    const result = await migrate(db, {
        "0001_notes": createNotes,
        "0002_failing": failing,
        "0003_add_text": addText,
    });

    assertEquals(result.ok, false);
    assertEquals(await tables(db), []);

    assertEquals(await migrate(db, { "0001_notes": createNotes }), {
        ok: true,
        applied: ["0001_notes"],
    });
});

Deno.test("Verso's own migrations apply cleanly", async () => {
    await using db = await testDatabase();

    assertEquals((await migrate(db)).ok, true);
});

/** A parent table with a child whose rows are deleted with their parent. */
const createFamily = {
    up: async (db: Kysely<unknown>) => {
        await sql`create table parents (id text primary key)`.execute(db);
        await sql`create table children (
            id text primary key,
            parent_id text not null references parents (id) on delete cascade
        )`.execute(db);
        await sql`insert into parents values ('p')`.execute(db);
        await sql`insert into children values ('c', 'p')`.execute(db);
    },
};

/** Rebuilds `parents`, as SQLite needs to change a table, copying the rows that `copy` selects. */
const rebuildParents = (copy: string) => ({
    up: async (db: Kysely<unknown>) => {
        await sql`create table parents_new (id text primary key, name text)`.execute(db);
        await sql.raw(`insert into parents_new (id) select id from parents ${copy}`).execute(db);
        await sql`drop table parents`.execute(db);
        await sql`alter table parents_new rename to parents`.execute(db);
        await checkForeignKeys(db);
    },
});

const sqliteOnly = testDatabaseKind !== "sqlite";

Deno.test({
    name: "rebuilding a table on SQLite keeps the rows that refer to it",
    ignore: sqliteOnly,
    fn: async () => {
        await using db = await testDatabase();
        await migrate(db, { "0001_family": createFamily });

        const result = await migrate(db, {
            "0001_family": createFamily,
            "0002_rebuild": rebuildParents(""),
        });
        const children = await sql`select id from children`.execute(db);
        const { rows: [pragma] } = await sql`PRAGMA foreign_keys`.execute(db);

        assertEquals(result, { ok: true, applied: ["0002_rebuild"] });
        assertEquals(children.rows, [{ id: "c" }]);
        assertEquals(pragma, { foreign_keys: 1 });
    },
});

Deno.test({
    name: "a rebuild on SQLite that loses a referenced row fails, and changes nothing",
    ignore: sqliteOnly,
    fn: async () => {
        await using db = await testDatabase();
        await migrate(db, { "0001_family": createFamily });

        const result = await migrate(db, {
            "0001_family": createFamily,
            "0002_rebuild": rebuildParents("where false"),
        });
        const parents = await sql`select * from parents`.execute(db);

        assertEquals(result.ok, false);
        assertEquals(parents.rows, [{ id: "p" }]);
    },
});

Deno.test("the database was set up when its first migration ran", async () => {
    await using db = await testDatabase();
    await assertRejects(
        () => firstMigratedAt(db, { "1_notes": createNotes }),
        Error,
        "The database isn't set up",
    );

    const before = Date.now();
    await migrate(db, { "1_notes": createNotes });
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await migrate(db, { "1_notes": createNotes, "2_text": addText });

    const setUp = (await firstMigratedAt(db, { "1_notes": createNotes, "2_text": addText }))
        .getTime();
    assert(before <= setUp && setUp <= after, `${before} <= ${setUp} <= ${after}`);
});
