import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { Kysely } from "kysely";
import { testDatabase } from "../db/testing.ts";
import { fakeClock } from "./clock.ts";
import { type Context, createContext } from "./context.ts";
import { fakeTransport } from "./fake_transport.ts";
import { memoryFiles } from "./files.ts";
import { countingRandom, idGenerator } from "./ids.ts";
import { defaultSettings } from "./settings.ts";
import { urlBuilder } from "./urls.ts";
import { vipsImages } from "./vips_images.ts";

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
        files: memoryFiles(),
        images: vipsImages({ maxPixels: 8_294_400 }),
        identityProviders: {},
        settings: defaultSettings,
        // These tests don't federate.
        federation: {
            instanceKey: () => Promise.reject(new Error("Unused")),
            remoteKeys: {
                get: () => Promise.resolve(undefined),
                refresh: () => Promise.resolve(undefined),
            },
            isBlocked: () => Promise.resolve(false),
            resolve: () => Promise.resolve(undefined),
            forget: () => {},
        },
        subscribers: [],
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

Deno.test("work after a commit runs in order once it commits, before the transaction resolves", async () => {
    await using test = await open();
    const seen: string[] = [];
    const see = (name: string) => async () =>
        void seen.push(`${name}: ${(await noteIds(test.db)).length}`);

    await test.ctx.transaction(async (tx) => {
        await addNote(tx);
        await tx.afterCommit(see("outer"));
        await tx.transaction(async (inner) => {
            await addNote(inner);
            await inner.afterCommit(see("inner"));
        });

        assertEquals(seen, []);
    });

    // Both notes committed, which outside the transaction it can see.
    assertEquals(seen, ["outer: 2", "inner: 2"]);
});

Deno.test("work after a commit doesn't run if it rolls back, and runs at once outside one", async () => {
    await using test = await open();
    const ran: string[] = [];

    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await tx.afterCommit(() => Promise.resolve(void ran.push("rolled back")));
            throw new Error("oops");
        })
    );
    await test.ctx.afterCommit(() => Promise.resolve(void ran.push("outside")));

    assertEquals(ran, ["outside"]);
});

Deno.test("work after a commit that fails doesn't fail what committed, or later work", async () => {
    await using test = await open();
    const ran: string[] = [];

    const id = await test.ctx.transaction(async (tx) => {
        await tx.afterCommit(() => Promise.reject(new Error("oops")));
        await tx.afterCommit(() => Promise.resolve(void ran.push("later")));
        return await addNote(tx);
    });
    await test.ctx.afterCommit(() => Promise.reject(new Error("oops")));

    assertEquals(await noteIds(test.db), [id]);
    assertEquals(ran, ["later"]);
});
