import { assertEquals, assertRejects } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { backoffMs, claim, complete, deleteExpiredJobs, enqueue, fail } from "./queue.ts";

const firstId = "019b76da-a800-7000-8000-000000000001";

const open = () => createTestContext();

Deno.test("an enqueued job is due now with its attempts unused", async () => {
    await using test = await open();

    const id = await enqueue(test.ctx, { queue: "deliver", payload: { to: "b.test", n: [1] } });
    assertEquals(id, firstId);

    const now = test.ctx.clock.now();
    assertEquals(await test.ctx.db.selectFrom("jobs").selectAll().execute(), [{
        id: firstId,
        queue: "deliver",
        payload: { to: "b.test", n: [1] },
        priority: 0,
        run_at: now,
        attempts: 0,
        max_attempts: 10,
        lease_owner: null,
        lease_expires_at: null,
        dedupe_key: null,
        last_error: null,
        created_at: now,
        keep_until: null,
        finished_at: null,
    }]);
});

Deno.test("a job exists only if the work that enqueued it commits", async () => {
    await using test = await open();

    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await enqueue(tx, { queue: "deliver", payload: {} });
            throw new Error("oops");
        })
    );
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);

    await test.ctx.transaction((tx) => enqueue(tx, { queue: "deliver", payload: {} }));
    assertEquals((await test.ctx.db.selectFrom("jobs").select("id").execute()).length, 1);
});

Deno.test("a dedupe key that is already queued adds nothing", async () => {
    await using test = await open();

    const job = { queue: "cleanup", payload: {}, dedupeKey: "cleanup:2026-01-01T00" };
    assertEquals(await enqueue(test.ctx, job), firstId);
    assertEquals(await enqueue(test.ctx, { ...job, payload: { again: true } }), undefined);
    assertEquals(await test.ctx.db.selectFrom("jobs").select(["id", "payload"]).execute(), [
        { id: firstId, payload: {} },
    ]);

    // Jobs without a key never collide.
    await enqueue(test.ctx, { queue: "cleanup", payload: {} });
    await enqueue(test.ctx, { queue: "cleanup", payload: {} });
    assertEquals((await test.ctx.db.selectFrom("jobs").select("id").execute()).length, 3);
});

const minute = 60_000;
const options = { queue: "deliver", worker: "w1", limit: 10, leaseMs: minute };

const ids = (jobs: { payload: Record<string, unknown> }[]) => jobs.map((job) => job.payload.n);

Deno.test("claiming takes due jobs of one queue, by priority and then age", async () => {
    await using test = await open();

    const later = new Date(test.clock.now().getTime() + minute);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 2 }, priority: 5 });
    await enqueue(test.ctx, { queue: "notify", payload: { n: 3 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 4 }, runAt: later });
    test.clock.advance(1);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 5 }, priority: 5 });

    assertEquals(ids(await claim(test.ctx, { ...options, limit: 2 })), [2, 5]);

    const [job] = await claim(test.ctx, options);
    assertEquals(ids([job]), [1]);
    assertEquals(job.attempts, 1);
    assertEquals(job.lease_owner, "w1");
    assertEquals(job.lease_expires_at, new Date(test.clock.now().getTime() + minute));
    assertEquals(await claim(test.ctx, options), []);
});

Deno.test("a job is claimed again only after its lease expires", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 } });
    const [first] = await claim(test.ctx, options);

    test.clock.advance(minute - 1);
    assertEquals(await claim(test.ctx, { ...options, worker: "w2" }), []);

    test.clock.advance(1);
    const [second] = await claim(test.ctx, { ...options, worker: "w2" });
    assertEquals([second.lease_owner, second.attempts], ["w2", 2]);

    // The first worker lost its lease, so finishing late changes nothing.
    await complete(test.ctx, first);
    await fail(test.ctx, first, "late");
    assertEquals(
        await test.ctx.db.selectFrom("jobs").select(["lease_owner", "last_error"]).execute(),
        [
            { lease_owner: "w2", last_error: null },
        ],
    );

    await complete(test.ctx, second);
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("concurrent claims never share a job", async () => {
    await using test = await open();

    for (let n = 0; n < 20; n++) await enqueue(test.ctx, { queue: "deliver", payload: { n } });

    const claims = await Promise.all(
        ["w1", "w2", "w3"].map((worker) => claim(test.ctx, { ...options, worker, limit: 8 })),
    );

    const claimed = claims.flatMap(ids);
    assertEquals(claimed.length, 20);
    assertEquals(new Set(claimed).size, 20);
});

Deno.test("a failed job is retried after a backoff, then kept as a dead letter", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 }, maxAttempts: 2 });
    const [first] = await claim(test.ctx, options);
    await fail(test.ctx, first, "timed out", () => 0);

    test.clock.advance(15_000 - 1);
    assertEquals(await claim(test.ctx, options), []);

    test.clock.advance(1);
    const [second] = await claim(test.ctx, options);
    assertEquals([second.attempts, second.last_error], [2, "timed out"]);

    await fail(test.ctx, second, "refused");
    test.clock.advance(24 * 60 * minute);
    assertEquals(await claim(test.ctx, options), []);

    assertEquals(
        await test.ctx.db.selectFrom("jobs")
            .select(["attempts", "lease_owner", "lease_expires_at", "last_error"]).execute(),
        [{ attempts: 2, lease_owner: null, lease_expires_at: null, last_error: "refused" }],
    );
});

Deno.test("a dead letter is deleted 30 days after it died, and a job being retried isn't", async () => {
    await using test = await open();
    const day = 24 * 60 * minute;
    const queues = async () =>
        (await test.ctx.db.selectFrom("jobs").select("queue").orderBy("queue").execute())
            .map((row) => row.queue);

    await enqueue(test.ctx, { queue: "dead", payload: {}, maxAttempts: 1 });
    await enqueue(test.ctx, { queue: "retried", payload: {} });
    test.clock.advance(day);
    for (const queue of ["dead", "retried"]) {
        const [job] = await claim(test.ctx, { ...options, queue });
        await fail(test.ctx, job, "refused");
    }

    test.clock.advance(30 * day - 1);
    await deleteExpiredJobs(test.ctx);
    assertEquals(await queues(), ["dead", "retried"]);

    test.clock.advance(1);
    await deleteExpiredJobs(test.ctx);
    assertEquals(await queues(), ["retried"]);

    // Long after its next run was due, a job being retried is still not dead.
    test.clock.advance(day);
    await deleteExpiredJobs(test.ctx);
    assertEquals(await queues(), ["retried"]);
});

Deno.test("backoff doubles from 30 seconds up to six hours, with jitter", () => {
    assertEquals([1, 2, 3].map((attempts) => backoffMs(attempts, () => 1)), [
        30_000,
        60_000,
        120_000,
    ]);

    assertEquals(backoffMs(1, () => 0), 15_000);
    assertEquals(backoffMs(30, () => 1), 6 * 60 * minute);
});
