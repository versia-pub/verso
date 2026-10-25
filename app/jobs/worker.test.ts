import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { enqueue } from "./queue.ts";
import { drain, pause, PermanentFailure, type Queue, RetryAt, work } from "./worker.ts";

const open = () => createTestContext();

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

/**
 * Waits until `running()` jobs run at once, or a second passes, so jobs that may run together do,
 * however busy the machine is.
 */
const together = async (running: () => number, want: number) => {
    const deadline = Date.now() + 1000;
    while (running() < want && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

Deno.test("each queue's jobs run, at most `concurrency` at a time, then are deleted", async () => {
    await using test = await open();

    const ran: unknown[] = [];
    const running: Record<string, number> = { deliver: 0, notify: 0 };
    const mostAtOnce: Record<string, number> = { deliver: 0, notify: 0 };
    const handler: Queue["handler"] = async (_ctx, job) => {
        mostAtOnce[job.queue] = Math.max(mostAtOnce[job.queue], ++running[job.queue]);
        await together(() => running[job.queue], job.queue === "deliver" ? 2 : 1);
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

Deno.test("at most `perGroup` jobs of each group run at a time, each claimed once", async () => {
    await using test = await open();

    const running = new Map<string, number>();
    const mostAtOnce = new Map<string, number>();
    const attempts: number[] = [];
    const handler: Queue["handler"] = async (_ctx, job) => {
        const group = job.group_key ?? "none";
        running.set(group, (running.get(group) ?? 0) + 1);
        mostAtOnce.set(group, Math.max(mostAtOnce.get(group) ?? 0, running.get(group) ?? 0));
        attempts.push(job.attempts);

        await together(() => running.get(group) ?? 0, 2);
        running.set(group, (running.get(group) ?? 0) - 1);
    };

    // In this order, the second claim is two of b.example's, with one already running.
    const groups = ["b", "c", "b", "b", "b", "b", "c", undefined, "c", undefined, undefined, "b"];
    for (const [n, group] of groups.entries()) {
        await enqueue(test.ctx, {
            queue: "deliver",
            payload: { n },
            group: group && `${group}.example`,
        });
    }

    const stop = start(test.ctx, { deliver: { handler, concurrency: 5, perGroup: 2 } });
    await until(async () =>
        (await test.ctx.db.selectFrom("jobs").select("id").execute()).length === 0
    );
    await stop();

    assertEquals(attempts, Array(12).fill(1));
    assertEquals(mostAtOnce.get("b.example"), 2);
    assertEquals(mostAtOnce.get("c.example"), 2);
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

Deno.test("drain runs due jobs, and the jobs they enqueue, until none are left", async () => {
    await using test = await open();

    const ran: unknown[] = [];

    const queues: Record<string, Queue> = {
        deliver: {
            handler: async (ctx, job) => {
                ran.push(job.payload.n);
                await enqueue(ctx, { queue: "notify", payload: { n: `notify ${job.payload.n}` } });
            },
            concurrency: 1,
        },
        notify: {
            handler: (_, job) => Promise.resolve(void ran.push(job.payload.n)),
            concurrency: 1,
        },
    };

    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 2 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 3 } });
    await enqueue(test.ctx, { queue: "notify", payload: { n: "later" }, runAt: new Date(9e12) });

    assertEquals(await drain(test.ctx, queues), 6);
    assertEquals(ran, [1, "notify 1", 2, "notify 2", 3, "notify 3"]);
    assertEquals(await test.ctx.db.selectFrom("jobs").select("queue").execute(), [{
        queue: "notify",
    }]);
});

Deno.test("drain runs a failed job again only once the clock passes its backoff", async () => {
    await using test = await open();

    let runs = 0;

    const queues: Record<string, Queue> = {
        deliver: {
            handler: () => Promise.reject(new Error(`failure ${++runs}`)),
            concurrency: 1,
        },
    };

    await enqueue(test.ctx, { queue: "deliver", payload: {} });
    assertEquals(await drain(test.ctx, queues), 1);
    assertEquals(await drain(test.ctx, queues), 0);

    test.clock.advance(30_000);
    assertEquals(await drain(test.ctx, queues), 1);
    assertEquals(runs, 2);
});

Deno.test("a job that fails permanently isn't run again", async () => {
    await using test = await open();

    let runs = 0;

    const queues: Record<string, Queue> = {
        inbox: {
            handler: () => Promise.reject(new PermanentFailure(`failure ${++runs}`)),
            concurrency: 1,
        },
    };

    await enqueue(test.ctx, { queue: "inbox", payload: {} });
    assertEquals(await drain(test.ctx, queues), 1);

    test.clock.advance(7 * 24 * 60 * 60_000);
    assertEquals(await drain(test.ctx, queues), 0);
    assertEquals(runs, 1);

    const [job] = await test.ctx.db.selectFrom("jobs").select("last_error").execute();
    assertEquals(job.last_error?.startsWith("PermanentFailure: failure 1"), true);
});

Deno.test("a dead letter keeps what its queue keeps of its payload, however it died", async () => {
    await using test = await open();
    const queues: Record<string, Queue> = {
        refused: {
            handler: () => Promise.reject(new PermanentFailure("refused")),
            concurrency: 1,
            deadPayload: (payload) => ({ n: payload.n }),
        },
        failing: {
            handler: () => Promise.reject(new Error("down")),
            concurrency: 1,
            deadPayload: (payload) => ({ n: payload.n }),
        },
    };

    await enqueue(test.ctx, { queue: "refused", payload: { n: 1, body: "large" } });
    await enqueue(test.ctx, { queue: "failing", payload: { n: 2, body: "large" }, maxAttempts: 1 });
    await drain(test.ctx, queues);

    const jobs = await test.ctx.db.selectFrom("jobs").select("payload").orderBy("id").execute();
    assertEquals(jobs.map((job) => job.payload), [{ n: 1 }, { n: 2 }]);
});

Deno.test("a job that asks to be retried at a time runs then, however often it asks", async () => {
    await using test = await open();

    let runs = 0;

    const queues: Record<string, Queue> = {
        deliver: {
            handler: () => {
                runs++;
                const later = new Date(test.clock.now().getTime() + 60_000);
                return Promise.reject(new RetryAt(later, "rate limited"));
            },
            concurrency: 1,
        },
    };

    await enqueue(test.ctx, { queue: "deliver", payload: {}, maxAttempts: 2 });

    for (let round = 0; round < 5; round++) {
        assertEquals(await drain(test.ctx, queues), 1);
        assertEquals(await drain(test.ctx, queues), 0);
        test.clock.advance(60_000);
    }

    assertEquals(runs, 5);
});

Deno.test("a pause removes every listener it added, however it ends", async () => {
    /** An event target that counts the listeners on it. */
    class Counting extends EventTarget {
        listening = 0;

        override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
            this.listening++;
            super.addEventListener(...args);
        }

        override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
            this.listening--;
            super.removeEventListener(...args);
        }
    }

    const events = new Counting();
    const stop = new AbortController();
    const wakeups = [{ events, name: "a" }, { events, name: "b" }];

    await pause(1, stop.signal, wakeups);
    const woken = pause(60_000, stop.signal, wakeups);
    events.dispatchEvent(new Event("b"));
    await woken;

    assertEquals(events.listening, 0);
});
