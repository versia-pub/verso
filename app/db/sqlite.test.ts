import { assertEquals } from "@std/assert";
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
