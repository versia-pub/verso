import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects } from "@std/assert";
import { type Dialect, Kysely, PGliteDialect } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { columnTypes } from "./columns.ts";
import { sqliteDialect } from "./sqlite.ts";

type Database = {
  notes: { id: number; text: string };
  events: { id: number; at: Date | null };
};

const dialects: Record<string, () => Promise<Dialect>> = {
  PGlite: async () => new PGliteDialect({ pglite: await PGlite.create() }),
  SQLite: () => Promise.resolve(sqliteDialect(new DatabaseSync(":memory:"))),
};

for (const [name, dialect] of Object.entries(dialects)) {
  const open = async () => {
    const db = new Kysely<Database>({ dialect: await dialect() });
    await db.schema.createTable("notes")
      .addColumn("id", "integer", (column) => column.primaryKey())
      .addColumn("text", "text", (column) => column.notNull())
      .execute();
    await db.schema.createTable("events")
      .addColumn("id", "integer", (column) => column.primaryKey())
      .addColumn("at", columnTypes(db).timestamp)
      .execute();
    return db;
  };

  Deno.test(`${name}: queries run`, async () => {
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

  Deno.test(`${name}: writes can return rows`, async () => {
    await using db = await open();
    assertEquals(
      await db.insertInto("notes").values({ id: 1, text: "one" })
        .returning(["id", "text"]).execute(),
      [{ id: 1, text: "one" }],
    );
  });

  Deno.test(`${name}: a failed transaction leaves nothing behind`, async () => {
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

  Deno.test(`${name}: queries outside a transaction wait for it to finish`, async () => {
    await using db = await open();
    const order: string[] = [];
    let inTransaction = () => {};
    const started = new Promise<void>((resolve) => inTransaction = resolve);
    // On one connection, a query slipping into the transaction would see its uncommitted row.
    const transaction = assertRejects(() =>
      db.transaction().execute(async (tx) => {
        inTransaction();
        await tx.insertInto("notes").values({ id: 1, text: "one" }).execute();
        order.push("transaction");
        throw new Error("rolled back");
      })
    );
    await started;
    const outside = await db.selectFrom("notes").selectAll().execute();
    order.push("outside");
    await transaction;
    assertEquals(order, ["transaction", "outside"]);
    assertEquals(outside, []);
  });

  Deno.test(`${name}: timestamps come back as the same Date`, async () => {
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

  Deno.test(`${name}: timestamps sort and compare in time order`, async () => {
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
}
