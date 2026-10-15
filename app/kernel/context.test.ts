import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { Kysely } from "kysely";
import { testDatabase } from "../db/testing.ts";
import { fakeClock } from "./clock.ts";
import { type Context, createContext } from "./context.ts";
import { fakeTransport } from "./fake_transport.ts";
import { countingRandom, idGenerator } from "./ids.ts";
import { urlBuilder } from "./urls.ts";

type Notes = { notes: { id: string } };

const open = async () => {
    const db = await testDatabase<Notes>();

    await db.schema.createTable("notes").addColumn("id", "text", (column) => column.primaryKey())
        .execute();

    const clock = fakeClock();
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder("social.example"),
        transport: fakeTransport(),
        identityProviders: {},
        db,
    });

    return { db, ctx, [Symbol.asyncDispose]: () => db.destroy() };
};

const addNote = async (ctx: Context<Notes>) => {
    const id = ctx.ids();
    await ctx.db.insertInto("notes").values({ id }).execute();

    return id;
};

const noteIds = async (db: Kysely<Notes>) =>
    (await db.selectFrom("notes").select("id").orderBy("id").execute()).map((note) => note.id);

Deno.test("a transaction commits when its work resolves", async () => {
    await using test = await open();
    const ids = await test.ctx.transaction(async (tx) => [await addNote(tx), await addNote(tx)]);

    assertEquals(await noteIds(test.db), ids);
});

Deno.test("a transaction leaves nothing behind when its work throws", async () => {
    await using test = await open();

    await assertRejects(
        () =>
            test.ctx.transaction(async (tx) => {
                await addNote(tx);
                throw new Error("oops");
            }),
        Error,
        "oops",
    );

    assertEquals(await noteIds(test.db), []);
});

Deno.test("a nested transaction joins the outer one", async () => {
    await using test = await open();

    await assertRejects(
        () =>
            test.ctx.transaction(async (outer) => {
                await addNote(outer);

                const inner = await outer.transaction(async (tx) => {
                    assertStrictEquals(tx.db, outer.db);
                    return await addNote(tx);
                });

                // The outer unit sees the inner write before anything commits.
                assertEquals((await noteIds(outer.db)).at(-1), inner);
                throw new Error("oops");
            }),
        Error,
        "oops",
    );

    assertEquals(await noteIds(test.db), []);
});
