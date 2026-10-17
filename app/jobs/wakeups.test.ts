import { assertEquals, assertRejects } from "@std/assert";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { connect, type Database } from "../db/database.ts";
import { testDatabaseKind, testPostgresUrl } from "../db/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { enqueue } from "./queue.ts";
import { listenForJobs } from "./wakeups.ts";
import { work } from "./worker.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("a wakeup starts an idle queue's new job before the next poll", async () => {
    await using test = await createTestContext();

    const ctx = test.ctx;
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

        await using test = await createTestContext({
            db: connect<Database>(
                new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
            ),
        });

        const ctx = test.ctx;

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

Deno.test("when Postgres can't be reached, workers are left to poll", async () => {
    assertEquals(
        await listenForJobs({ postgres: "postgres://verso@127.0.0.1:1/verso" }),
        undefined,
    );
});
