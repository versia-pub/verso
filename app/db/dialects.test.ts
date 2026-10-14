import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects } from "@std/assert";
import { type Dialect, Kysely, PGliteDialect } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { sqliteDialect } from "./sqlite.ts";

type Database = { notes: { id: number; text: string } };

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
}
