import { assertEquals } from "@std/assert";
import { type Kysely, sql } from "kysely";
import { migrate } from "./migrate.ts";
import { testDatabase } from "./testing.ts";

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
