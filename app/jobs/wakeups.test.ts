import { assertEquals, assertRejects } from "@std/assert";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { connect, type Database } from "../db/database.ts";
import { testDatabaseKind, testPostgresUrl } from "../db/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { delay, until } from "../testing/waiting.ts";
import { enqueue, enqueueAll } from "./job_queries.ts";
import { hearJobWakeups, listenForJobs } from "./wakeups.ts";
import { work } from "./worker.ts";

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

    await until(() => ran);

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

        await until(() => heard.length > 0);
        await delay(100);

        assertEquals(heard, ["deliver"]);
    },
});

Deno.test({
    name: "on Postgres, enqueueing several jobs notifies each queue that got one, once, if asked",
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
        await enqueue(ctx, { queue: "other", payload: {}, dedupeKey: "queued" });

        await using wakeups = await listenForJobs({ postgres: url });
        const heard: string[] = [];
        for (const queue of ["deliver", "fetch", "other", "quiet"]) {
            wakeups?.addEventListener(queue, () => heard.push(queue));
        }

        await ctx.transaction((tx) =>
            enqueueAll(tx, [
                { queue: "deliver", payload: { n: 1 } },
                { queue: "fetch", payload: {} },
                { queue: "deliver", payload: { n: 2 } },
                { queue: "other", payload: {}, dedupeKey: "queued" },
                // Workers find these by polling.
                { queue: "quiet", payload: {}, wake: false },
            ])
        );
        await enqueue(ctx, { queue: "quiet", payload: {}, wake: false });

        await until(() => heard.length >= 2);
        await delay(100);

        assertEquals(heard.toSorted(), ["deliver", "fetch"]);
    },
});

Deno.test("when Postgres can't be reached, workers are left to poll", async () => {
    assertEquals(
        await listenForJobs({ postgres: "postgres://verso@127.0.0.1:1/verso" }),
        undefined,
    );
});

Deno.test({
    name: "on SQLite, enqueueing wakes each queue that got a job, once its transaction commits",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await createTestContext();

        const ctx = test.ctx;
        await using wakeups = hearJobWakeups(ctx);
        const heard: string[] = [];
        for (const queue of ["deliver", "fetch", "quiet"]) {
            wakeups.addEventListener(queue, () => heard.push(queue));
        }

        await assertRejects(() =>
            ctx.transaction(async (tx) => {
                await enqueue(tx, { queue: "deliver", payload: {} });
                throw new Error("rolled back");
            })
        );

        await ctx.transaction(async (tx) => {
            await enqueue(tx, { queue: "deliver", payload: {} });
            await enqueueAll(tx, [
                { queue: "fetch", payload: {} },
                { queue: "quiet", payload: {}, wake: false },
            ]);
            await enqueue(tx, { queue: "quiet", payload: {}, wake: false });

            assertEquals(heard, []);
        });

        assertEquals(heard, ["deliver", "fetch"]);

        await wakeups[Symbol.asyncDispose]();
        await enqueue(ctx, { queue: "deliver", payload: {} });

        assertEquals(heard, ["deliver", "fetch"]);
    },
});
