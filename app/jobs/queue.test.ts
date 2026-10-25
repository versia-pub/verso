import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CompiledQuery, sql } from "kysely";
import { testDatabaseKind } from "../db/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { JobsTable } from "./tables.ts";
import {
    backoffMs,
    claim,
    complete,
    deleteExpiredJobs,
    enqueue,
    enqueueAll,
    fail,
    giveUp,
    postpone,
    postponeGroup,
    release,
    resumeGroup,
} from "./queue.ts";

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
        group_key: null,
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

Deno.test("jobs enqueued together are all added, but for dedupe keys already queued", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: "deliver", payload: {}, dedupeKey: "queued" });

    const jobs = Array.from({ length: 2500 }, (_, n) => ({ queue: "deliver", payload: { n } }));
    await enqueueAll(test.ctx, [
        ...jobs,
        { queue: "deliver", payload: { n: "again" }, dedupeKey: "queued" },
        { queue: "fetch", payload: { n: "first" }, dedupeKey: "new", group: "b.example" },
        { queue: "fetch", payload: { n: "second" }, dedupeKey: "new" },
    ]);

    const rows = await test.ctx.db.selectFrom("jobs").select(["queue", "payload", "group_key"])
        .orderBy("id").execute();
    assertEquals(rows.length, 2502);
    assertEquals(rows.at(1), { queue: "deliver", payload: { n: 0 }, group_key: null });
    assertEquals(rows.at(-1), { queue: "fetch", payload: { n: "first" }, group_key: "b.example" });
    await enqueueAll(test.ctx, []);
});

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

Deno.test("claiming finds due jobs by an index of only the jobs that can run", async () => {
    await using test = await open();
    const { db } = test.ctx;
    // As `claim` selects them.
    const due = db.selectFrom("jobs").select("id")
        .where("queue", "=", "deliver")
        .where("run_at", "<=", test.ctx.clock.now())
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .orderBy("priority", "desc").orderBy("run_at").orderBy("id")
        .compile();

    const sqlite = testDatabaseKind === "sqlite";
    // With so few rows, Postgres would rather scan the table, unless told not to.
    if (!sqlite) await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain ${sqlite ? "query plan " : ""}${due.sql}`, [...due.parameters]),
    );

    assertStringIncludes(JSON.stringify(plan.rows), "jobs_claimable");
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
    await fail(test.ctx, first, "timed out", { random: () => 0 });

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

Deno.test("a postponed job runs at the given time, with its attempt given back", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: {}, maxAttempts: 1 });
    const [job] = await claim(test.ctx, options);
    await postpone(test.ctx, job, new Date(test.clock.now().getTime() + 10 * minute), "busy");

    test.clock.advance(10 * minute - 1);
    assertEquals(await claim(test.ctx, options), []);

    test.clock.advance(1);
    const [again] = await claim(test.ctx, options);
    assertEquals([again.attempts, again.last_error], [1, "busy"]);
});

Deno.test("claiming can skip groups, but never jobs without one", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 }, group: "b.example" });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 2 }, group: "c.example" });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 3 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 4 }, group: "d.example" });

    const skipGroups = ["b.example", "d.example"];
    assertEquals(ids(await claim(test.ctx, { ...options, skipGroups })).toSorted(), [2, 3]);
    assertEquals(ids(await claim(test.ctx, { ...options, skipGroups: [] })).toSorted(), [1, 4]);
});

Deno.test("a paused group's jobs aren't claimed until the pause ends", async () => {
    await using test = await open();
    const at = (minutes: number) => new Date(test.clock.now().getTime() + minutes * minute);
    const add = (n: number, job: { queue?: string; group?: string }) =>
        enqueue(test.ctx, { queue: "deliver", payload: { n }, ...job });

    await add(1, { group: "b.example" });
    await add(2, { group: "c.example" });
    await add(3, {});
    await add(4, { queue: "notify", group: "b.example" });
    await postponeGroup(test.ctx, "deliver", "b.example", at(10));
    // A shorter pause doesn't shorten it.
    await postponeGroup(test.ctx, "deliver", "b.example", at(5));
    await add(5, { group: "b.example" });

    const claimed = await claim(test.ctx, options);
    assertEquals(ids(claimed), [2, 3]);
    for (const job of claimed) await complete(test.ctx, job);
    assertEquals(ids(await claim(test.ctx, { ...options, queue: "notify" })), [4]);

    test.clock.advance(10 * minute - 1);
    assertEquals(await claim(test.ctx, options), []);
    test.clock.advance(1);
    assertEquals(ids(await claim(test.ctx, options)), [1, 5]);

    // Only its row is written, not each job's, and it goes once it ends.
    const rows = await test.ctx.db.selectFrom("jobs").select(["run_at"]).execute();
    assertEquals(rows.every((row) => row.run_at <= at(0)), true);
    await deleteExpiredJobs(test.ctx);
    assertEquals(await test.ctx.db.selectFrom("job_pauses").selectAll().execute(), []);
});

Deno.test("a group's waiting jobs are made due together when it is resumed", async () => {
    await using test = await open();
    const at = (minutes: number) => new Date(test.clock.now().getTime() + minutes * minute);
    const add = (n: number, job: { queue?: string; group?: string; runAt?: Date }) =>
        enqueue(test.ctx, { queue: "deliver", payload: { n }, ...job });

    await add(1, { group: "b.example", runAt: at(-1) });
    await add(2, { group: "b.example", runAt: at(10) });
    await add(3, { group: "c.example", runAt: at(10) });
    await add(4, { runAt: at(10) });
    await add(5, { queue: "notify", group: "b.example", runAt: at(10) });
    const [running] = await claim(test.ctx, { ...options, limit: 1 });
    await postponeGroup(test.ctx, "deliver", "b.example", at(20));

    await resumeGroup(test.ctx, "deliver", "b.example");

    const rows = await test.ctx.db.selectFrom("jobs").select(["payload", "run_at"]).execute();
    const runAt = Object.fromEntries(rows.map((row) => [row.payload.n, row.run_at]));
    assertEquals(running.payload.n, 1);
    assertEquals(runAt, { 1: at(-1), 2: at(0), 3: at(10), 4: at(10), 5: at(10) });
    assertEquals(ids(await claim(test.ctx, options)), [2]);
});

Deno.test("a job given back is as it was before it was claimed", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: {}, maxAttempts: 1 });
    const [job] = await claim(test.ctx, options);
    await release(test.ctx, job);

    const [again] = await claim(test.ctx, { ...options, worker: "w2" });
    assertEquals([again.attempts, again.lease_owner, again.run_at], [1, "w2", job.run_at]);
});

Deno.test("a job given up on is a dead letter at once, with its error", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: "deliver", payload: {}, maxAttempts: 5 });
    const [job] = await claim(test.ctx, options);
    await giveUp(test.ctx, job, "invalid");

    test.clock.advance(24 * 60 * minute);
    assertEquals(await claim(test.ctx, options), []);

    assertEquals(
        await test.ctx.db.selectFrom("jobs")
            .select(["attempts", "lease_owner", "lease_expires_at", "last_error"]).execute(),
        [{ attempts: 5, lease_owner: null, lease_expires_at: null, last_error: "invalid" }],
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

Deno.test("dead letters are kept for as long as settings say", async () => {
    await using test = await createTestContext({ settings: { deadLetterMs: minute } });
    await enqueue(test.ctx, { queue: "deliver", payload: {}, maxAttempts: 1 });
    const [job] = await claim(test.ctx, options);
    await giveUp(test.ctx, job, "invalid");

    test.clock.advance(minute);
    await deleteExpiredJobs(test.ctx);

    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("a dead letter keeps what its queue keeps of its payload, and frees its key", async () => {
    await using test = await open();
    const summary = () => ({ kept: "summary" });
    const dead = async (key: string, end: (job: JobsTable) => Promise<void>, keepUntil?: Date) => {
        await enqueue(test.ctx, {
            queue: "deliver",
            payload: { body: "large" },
            maxAttempts: 1,
            dedupeKey: key,
            keepUntil,
        });
        const [job] = await claim(test.ctx, options);
        await end(job);

        return await test.ctx.db.selectFrom("jobs").select(["payload", "dedupe_key"])
            .where("id", "=", job.id).executeTakeFirstOrThrow();
    };

    assertEquals(await dead("a", (job) => giveUp(test.ctx, job, "invalid", summary)), {
        payload: { kept: "summary" },
        dedupe_key: null,
    });
    assertEquals(
        await dead("b", (job) => fail(test.ctx, job, "refused", { deadPayload: summary })),
        { payload: { kept: "summary" }, dedupe_key: null },
    );
    // Without a summary it is kept whole, and while it is kept anyway, so is its key.
    const later = new Date(test.clock.now().getTime() + minute);
    assertEquals(await dead("c", (job) => giveUp(test.ctx, job, "invalid"), later), {
        payload: { body: "large" },
        dedupe_key: "c",
    });

    // A job that will be retried keeps both.
    await enqueue(test.ctx, { queue: "deliver", payload: { body: "large" }, dedupeKey: "d" });
    const [retried] = await claim(test.ctx, options);
    await fail(test.ctx, retried, "refused", { deadPayload: summary });
    assertEquals(
        await test.ctx.db.selectFrom("jobs").select(["payload", "dedupe_key"])
            .where("id", "=", retried.id).executeTakeFirstOrThrow(),
        { payload: { body: "large" }, dedupe_key: "d" },
    );

    // The same work can be queued again.
    assertEquals(
        typeof await enqueue(test.ctx, { queue: "x", payload: {}, dedupeKey: "a" }),
        "string",
    );
    assertEquals(await enqueue(test.ctx, { queue: "x", payload: {}, dedupeKey: "c" }), undefined);
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
