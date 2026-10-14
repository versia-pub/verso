import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects } from "@std/assert";
import { Kysely, PGliteDialect } from "kysely";

type Database = { notes: { id: number; text: string } };

const open = async () => {
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite: await PGlite.create() }),
  });
  await db.schema.createTable("notes")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .addColumn("text", "text", (column) => column.notNull())
    .execute();
  return db;
};

Deno.test("queries run on PGlite", async () => {
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

Deno.test("a failed transaction leaves nothing behind", async () => {
  await using db = await open();
  await assertRejects(
    () =>
      db.transaction().execute(async (tx) => {
        await tx.insertInto("notes").values({ id: 1, text: "one" }).execute();
        throw new Error("oops");
      }),
    Error,
    "oops",
  );
  assertEquals(await db.selectFrom("notes").selectAll().execute(), []);
});

Deno.test("queries outside a transaction wait for it to finish", async () => {
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
