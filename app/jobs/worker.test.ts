import { assertEquals } from "@std/assert";
import type { Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { testDatabase } from "../db/testing.ts";
import { fakeClock } from "../kernel/clock.ts";
import { createContext } from "../kernel/context.ts";
import { countingRandom, idGenerator } from "../kernel/ids.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { enqueue } from "./queue.ts";
import { type Queue, work } from "./worker.ts";

const open = async () => {
    const db = await testDatabase<Database>();
    await migrate(db);
    const clock = fakeClock();
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder("social.example"),
        db,
    });
    return { ctx, [Symbol.asyncDispose]: () => db.destroy() };
};

/** Starts a worker and returns a function that stops it and waits for it to finish. */
const start = (ctx: Parameters<typeof work>[0], queues: Record<string, Queue>) => {
    const controller = new AbortController();
    const done = work(ctx, queues, { worker: "w1", pollMs: 5, signal: controller.signal });
    return Object.assign(() => {
        controller.abort();
        return done;
    }, { done });
};

const until = async (condition: () => boolean | Promise<boolean>) => {
    while (!(await condition())) await new Promise((resolve) => setTimeout(resolve, 5));
};

Deno.test("each queue's jobs run, at most `concurrency` at a time, and are then deleted", async () => {
    await using test = await open();
    const ran: unknown[] = [];
    const running: Record<string, number> = { deliver: 0, notify: 0 };
    const mostAtOnce: Record<string, number> = { deliver: 0, notify: 0 };
    const handler: Queue["handler"] = async (_ctx, job) => {
        mostAtOnce[job.queue] = Math.max(mostAtOnce[job.queue], ++running[job.queue]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        ran.push(job.payload.n);
        running[job.queue]--;
    };
    for (let n = 0; n < 6; n++) await enqueue(test.ctx, { queue: "deliver", payload: { n } });
    await enqueue(test.ctx, { queue: "notify", payload: { n: "notify" } });
    const stop = start(test.ctx, {
        deliver: { handler, concurrency: 2 },
        notify: { handler, concurrency: 1 },
    });
    await until(async () =>
        (await test.ctx.db.selectFrom("jobs").select("id").execute()).length === 0
    );
    await stop();
    assertEquals(ran.toSorted(), [0, 1, 2, 3, 4, 5, "notify"]);
    assertEquals(mostAtOnce, { deliver: 2, notify: 1 });
});

Deno.test("a job that throws is kept with its error, to be retried", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: "deliver", payload: {} });
    const stop = start(test.ctx, {
        deliver: { handler: () => Promise.reject(new Error("refused")), concurrency: 1 },
    });
    const failed = () =>
        test.ctx.db.selectFrom("jobs").select(["attempts", "lease_owner", "last_error"])
            .executeTakeFirstOrThrow();
    await until(async () => (await failed()).last_error !== null);
    await stop();
    const job = await failed();
    assertEquals([job.attempts, job.lease_owner], [1, null]);
    assertEquals(job.last_error?.startsWith("Error: refused"), true);
});

Deno.test("stopping waits for running jobs to finish", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: "deliver", payload: {} });
    const { promise: release, resolve: finish } = Promise.withResolvers<void>();
    let started = false;
    let finished = false;
    const stop = start(test.ctx, {
        deliver: {
            handler: async () => {
                started = true;
                await release;
                finished = true;
            },
            concurrency: 1,
        },
    });
    await until(() => started);
    const stopped = stop();
    setTimeout(finish, 20);
    await stopped;
    assertEquals(finished, true);
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("with no queues, work runs until stopped", async () => {
    await using test = await open();
    let stopped = false;
    const stop = start(test.ctx, {});
    const done = stop.done.then(() => stopped = true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(stopped, false);
    await stop();
    await done;
    assertEquals(stopped, true);
});
