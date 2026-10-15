import { assertEquals, assertRejects } from "@std/assert";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { connect, type Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { testDatabase, testDatabaseKind, testPostgresUrl } from "../db/testing.ts";
import { fakeClock } from "../kernel/clock.ts";
import { type Context, createContext } from "../kernel/context.ts";
import { countingRandom, idGenerator } from "../kernel/ids.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { enqueue } from "./queue.ts";
import { listenForJobs } from "./wakeups.ts";
import { work } from "./worker.ts";

const contextFor = (db: Context["db"]) => {
    const clock = fakeClock();
    return createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder("social.example"),
        db,
    });
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("a wakeup starts an idle queue's new job before the next poll", async () => {
    await using db = await testDatabase<Database>();
    await migrate(db);
    const ctx = contextFor(db);
    const wakeups = new EventTarget();
    const stopping = new AbortController();
    let ran = false;
    const done = work(
        ctx,
        { deliver: { handler: () => Promise.resolve(void (ran = true)), concurrency: 1 } },
        {
            worker: "w1",
            pollMs: 60_000,
            signal: stopping.signal,
            wakeups,
        },
    );
    await delay(50);
    await enqueue(ctx, { queue: "deliver", payload: {} });
    wakeups.dispatchEvent(new Event("deliver"));
    const started = Date.now();
    while (!ran && Date.now() - started < 5_000) await delay(5);
    stopping.abort();
    await done;
    assertEquals(ran, true);
});

Deno.test({
    name: "on Postgres, enqueueing notifies listeners when the transaction commits",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        const url = await testPostgresUrl();
        if (!url) return;
        await using db = connect<Database>(
            new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
        );
        await migrate(db);
        const ctx = contextFor(db);
        await using wakeups = await listenForJobs({ postgres: url });
        const heard: string[] = [];
        wakeups?.addEventListener("deliver", () => heard.push("deliver"));

        await assertRejects(() =>
            ctx.transaction(async (tx) => {
                await enqueue(tx, { queue: "deliver", payload: {} });
                throw new Error("rolled back");
            })
        );
        await ctx.transaction(async (tx) => {
            await enqueue(tx, { queue: "deliver", payload: {} });
            await delay(100);
            assertEquals(heard, []);
        });
        const started = Date.now();
        while (heard.length === 0 && Date.now() - started < 5_000) await delay(5);
        await delay(100);
        assertEquals(heard, ["deliver"]);
    },
});
