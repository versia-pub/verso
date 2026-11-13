import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CompiledQuery, type KyselyPlugin, sql } from "kysely";
import { testDatabaseKind } from "../db/testing.ts";
import { createTestContext } from "../testing/context.ts";
import type { JobsTable } from "./tables.ts";
import {
    backoffMs,
    claim,
    claimable,
    complete,
    deadCounts,
    deadLetterQueues,
    deadLetters,
    deleteDeadLetters,
    deleteExpiredJobs,
    enqueue,
    enqueueAll,
    fail,
    giveUp,
    listDeadLetters,
    nextRunAt,
    postpone,
    queueStats,
    release,
    retryDeadLetters,
    waitingCounts,
} from "./job_queries.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { postponeGroup, resumeGroup } from "./job_pause_queries.ts";
import { jobWakeups } from "./wakeups.ts";

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

/** `at` is a time `minutes` from the test's clock now, and `add` enqueues a numbered job. */
const timeAndJobs = (test: Awaited<ReturnType<typeof open>>) => ({
    at: (minutes: number) => new Date(test.clock.now().getTime() + minutes * minute),
    add: (
        n: number,
        job: { queue?: string; group?: string; runAt?: Date; keepUntil?: Date },
    ) => enqueue(test.ctx, { queue: "deliver", payload: { n }, ...job }),
});

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

Deno.test("claiming takes due jobs of one queue, the longest due first, then the oldest", async () => {
    await using test = await open();
    const { at } = timeAndJobs(test);

    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 2 }, runAt: at(-1) });
    await enqueue(test.ctx, { queue: "notify", payload: { n: 3 } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 4 }, runAt: at(1) });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 5 }, runAt: at(-1) });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 6 }, runAt: at(-2) });

    assertEquals(ids(await claim(test.ctx, { ...options, limit: 3 })), [6, 2, 5]);

    const [job] = await claim(test.ctx, options);
    assertEquals(ids([job]), [1]);
    assertEquals(job.attempts, 1);
    assertEquals(job.lease_owner, "w1");
    assertEquals(job.lease_expires_at, new Date(test.clock.now().getTime() + minute));
    assertEquals(await claim(test.ctx, options), []);
});

Deno.test("claiming reads only due jobs, by an index of the jobs that can run", async () => {
    await using test = await open();
    const { db } = test.ctx;
    const now = test.clock.now();
    const later = new Date(now.getTime() + minute);

    // Waiting jobs that a claim must not read: a paused group's, and ones not due yet.
    await enqueueAll(
        test.ctx,
        Array.from({ length: 200 }, (_, n) => ({
            queue: "deliver",
            payload: { n },
            group: "b.example",
        })),
    );
    await postponeGroup(test.ctx, "deliver", "b.example", later);
    await enqueueAll(
        test.ctx,
        Array.from({ length: 200 }, (_, n) => ({ queue: "deliver", payload: { n }, runAt: later })),
    );
    await enqueue(test.ctx, { queue: "deliver", payload: { n: "due" }, group: "c.example" });

    const due = claimable(test.ctx, options, now).compile();

    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${due.sql}`, [...due.parameters]),
        );
        const details = plan.rows.map((row) => row.detail).join("\n");
        assertStringIncludes(details, "jobs_claimable (queue=? AND run_at<?)");

        return;
    }

    // With so few rows, Postgres would rather scan the table, unless told not to.
    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (analyze, format json) ${due.sql}`, [...due.parameters]),
    );

    const text = JSON.stringify(plan.rows);
    assertStringIncludes(text, "jobs_claimable");

    // The index scan read only the due job, none of the waiting ones.
    const scans = [...text.matchAll(/"Index Name":"jobs_claimable"[^}]*?"Actual Rows":(\d+)/g)];
    assertEquals(scans.map((scan) => scan[1]), ["1"]);
    assertEquals(/"Rows Removed by Filter":[1-9]/.test(text), false);
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
    assertEquals(ids(await claim(test.ctx, { ...options, skipGroups: ["b.example"] })), [4]);
    assertEquals(ids(await claim(test.ctx, { ...options, skipGroups: [] })), [1]);
});

Deno.test({
    name: "on SQLite, claiming from a queue with nothing due writes nothing",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const kinds: string[] = [];
        const counting: KyselyPlugin = {
            transformQuery: ({ node }) => {
                kinds.push(node.kind);
                return node;
            },
            transformResult: ({ result }) => Promise.resolve(result),
        };
        const ctx = { ...test.ctx, db: test.ctx.db.withPlugin(counting) };

        await enqueue(test.ctx, { queue: "notify", payload: { n: 1 } });
        await enqueue(test.ctx, {
            queue: "deliver",
            payload: { n: 2 },
            runAt: new Date(test.clock.now().getTime() + minute),
        });

        assertEquals(await claim(ctx, options), []);
        assertEquals(kinds, ["SelectQueryNode"]);

        test.clock.advance(minute);
        assertEquals(ids(await claim(ctx, options)), [2]);
    },
});

Deno.test("an idle worker learns when the next job of its queue is due", async () => {
    await using test = await open();
    const { at, add } = timeAndJobs(test);

    assertEquals(await nextRunAt(test.ctx, "deliver"), undefined);

    // Neither one due already, nor one that finished or died, nor another queue's, is next.
    await add(1, {});
    await add(2, { keepUntil: at(60) });
    await add(3, {});
    await add(4, { queue: "notify", runAt: at(1) });
    const [, finished, dead] = await claim(test.ctx, options);
    await complete(test.ctx, finished);
    await giveUp(test.ctx, dead, "invalid");
    await test.ctx.db.updateTable("jobs").set({ run_at: at(1) })
        .where("id", "in", [finished.id, dead.id]).execute();
    await add(5, { runAt: at(3) });
    await add(6, { runAt: at(2) });

    assertEquals(await nextRunAt(test.ctx, "deliver"), at(2));
});

Deno.test("a paused group's jobs aren't claimed until the pause ends", async () => {
    await using test = await open();
    const { at, add } = timeAndJobs(test);
    const runAts = async () => {
        const rows = await test.ctx.db.selectFrom("jobs").select(["payload", "run_at"]).execute();
        return Object.fromEntries(rows.map((row) => [row.payload.n, row.run_at]));
    };

    await add(1, { group: "b.example" });
    await add(2, { group: "c.example" });
    await add(3, {});
    await add(4, { queue: "notify", group: "b.example" });
    await add(6, { group: "b.example" });
    await add(7, { group: "b.example", runAt: at(20) });
    const [running] = await claim(test.ctx, { ...options, limit: 1 });
    assertEquals(running.payload.n, 1);

    await postponeGroup(test.ctx, "deliver", "b.example", at(10));
    // A shorter pause doesn't shorten it.
    await postponeGroup(test.ctx, "deliver", "b.example", at(5));
    await add(5, { group: "b.example" });
    await add(8, { group: "b.example", runAt: at(15) });

    // Its waiting jobs, and those enqueued since, are due when it ends, so claims don't read
    // them. A running job, and ones due after the pause anyway, are left as they are.
    assertEquals(await runAts(), {
        1: at(0),
        2: at(0),
        3: at(0),
        4: at(0),
        5: at(10),
        6: at(10),
        7: at(20),
        8: at(15),
    });

    const claimed = await claim(test.ctx, options);
    assertEquals(ids(claimed), [2, 3]);

    for (const job of [running, ...claimed]) await complete(test.ctx, job);
    assertEquals(ids(await claim(test.ctx, { ...options, queue: "notify" })), [4]);

    test.clock.advance(10 * minute - 1);
    assertEquals(await claim(test.ctx, options), []);

    test.clock.advance(1);
    // In the order they were made.
    assertEquals(ids(await claim(test.ctx, options)), [6, 5]);

    await deleteExpiredJobs(test.ctx);
    assertEquals(await test.ctx.db.selectFrom("job_pauses").selectAll().execute(), []);
});

Deno.test("pausing a group leaves its finished and dead jobs as they are", async () => {
    await using test = await open();
    const start = test.clock.now();
    const at = (minutes: number) => new Date(start.getTime() + minutes * minute);

    await enqueue(test.ctx, {
        queue: "deliver",
        payload: { n: 1 },
        group: "b.example",
        keepUntil: at(60),
    });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 2 }, group: "b.example" });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 3 }, group: "b.example" });
    const [finished, dead, abandoned] = await claim(test.ctx, options);
    await complete(test.ctx, finished);
    await giveUp(test.ctx, dead, "invalid");

    // The third job's lease has just run out, so it waits again, with the group.
    test.clock.advance(minute);
    await postponeGroup(test.ctx, "deliver", "b.example", at(11));
    await enqueueAll(test.ctx, [{ queue: "deliver", payload: { n: 4 }, group: "b.example" }]);

    const rows = await test.ctx.db.selectFrom("jobs").select(["id", "run_at"]).orderBy("id")
        .execute();
    assertEquals(rows.map((row) => row.run_at), [at(0), at(0), at(11), at(11)]);
    assertEquals(rows[2].id, abandoned.id);
});

Deno.test("a group's due jobs still aren't claimed while it is paused", async () => {
    await using test = await open();
    const later = new Date(test.clock.now().getTime() + minute);

    // As a job enqueued while the pause was being written would be: due, though the pause isn't
    // over.
    await postponeGroup(test.ctx, "deliver", "b.example", later);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 1 }, group: "b.example" });
    await test.ctx.db.updateTable("jobs").set({ run_at: test.clock.now() }).execute();

    assertEquals(await claim(test.ctx, options), []);

    test.clock.advance(minute);
    assertEquals(ids(await claim(test.ctx, options)), [1]);
});

Deno.test("a group's waiting jobs are made due together when it is resumed", async () => {
    await using test = await open();
    const { at, add } = timeAndJobs(test);

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

Deno.test("expired jobs are deleted a batch at a time, until none are left", async () => {
    await using test = await createTestContext({ settings: { deadLetterMs: minute } });
    const later = new Date(test.clock.now().getTime() + minute);

    for (const n of [1, 2, 3, 4, 5]) {
        await enqueue(test.ctx, { queue: "done", payload: { n }, keepUntil: later });
        await enqueue(test.ctx, { queue: "dead", payload: { n } });
    }
    // Not expired: a job that hasn't run, whatever its `keepUntil`, and a finished one still kept,
    // though it used every attempt.
    await enqueue(test.ctx, { queue: "waiting", payload: {}, keepUntil: later });
    await enqueue(test.ctx, {
        queue: "kept",
        payload: {},
        maxAttempts: 1,
        keepUntil: new Date(later.getTime() + minute),
    });
    for (const queue of ["done", "kept"]) {
        for (const job of await claim(test.ctx, { ...options, queue })) {
            await complete(test.ctx, job);
        }
    }
    for (const job of await claim(test.ctx, { ...options, queue: "dead" })) {
        await giveUp(test.ctx, job, "invalid");
    }

    test.clock.advance(minute);
    await deleteExpiredJobs(test.ctx, 2);

    const left = await test.ctx.db.selectFrom("jobs").select("queue").orderBy("queue").execute();
    assertEquals(left.map((job) => job.queue), ["kept", "waiting"]);
});

Deno.test("dead letters are found by an index of them only", async () => {
    await using test = await open();
    const { db } = test.ctx;

    await enqueueAll(
        test.ctx,
        Array.from({ length: 200 }, (_, n) => ({ queue: "deliver", payload: { n } })),
    );
    const dead = deadLetters(test.ctx, test.clock.now()).limit(1000).compile();

    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${dead.sql}`, [...dead.parameters]),
        );
        assertStringIncludes(plan.rows.map((row) => row.detail).join("\n"), "jobs_dead (run_at<?)");

        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (analyze, format json) ${dead.sql}`, [...dead.parameters]),
    );
    const text = JSON.stringify(plan.rows);

    // The index holds none of the waiting jobs, so the scan reads none.
    const scans = [...text.matchAll(/"Index Name":"jobs_dead"[^}]*?"Actual Rows":(\d+)/g)];
    assertEquals(scans.map((scan) => scan[1]), ["0"]);
    assertEquals(/"Rows Removed by Filter":[1-9]/.test(text), false);
});

Deno.test("queues' waiting jobs and dead letters are counted from their indexes", async () => {
    await using test = await open();
    const { db } = test.ctx;

    await enqueueAll(
        test.ctx,
        Array.from({ length: 200 }, (_, n) => ({ queue: "deliver", payload: { n } })),
    );
    const counts = [waitingCounts(test.ctx), deadCounts(test.ctx, test.clock.now())].map((query) =>
        query.compile()
    );

    if (testDatabaseKind === "sqlite") {
        const details = [];
        for (const query of counts) {
            const plan = await db.executeQuery<{ detail: string }>(
                CompiledQuery.raw(`explain query plan ${query.sql}`, [...query.parameters]),
            );
            details.push(plan.rows.map((row) => row.detail).join("\n"));
        }

        assertStringIncludes(details[0], "USING INDEX jobs_claimable");
        assertStringIncludes(details[1], "jobs_dead");

        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    for (
        const [query, index] of [[counts[0], "jobs_claimable"], [counts[1], "jobs_dead"]] as const
    ) {
        const plan = await db.executeQuery(
            CompiledQuery.raw(`explain (format json) ${query.sql}`, [...query.parameters]),
        );
        assertStringIncludes(JSON.stringify(plan.rows), `"Index Name":"${index}"`);
    }
});

Deno.test("a queue's stats count its waiting and dead jobs, and say how long one has been due", async () => {
    await using test = await open();
    const start = test.clock.now();

    await enqueue(test.ctx, { queue: "deliver", payload: { n: "oldest, running" } });
    test.clock.advance(minute);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: "due" } });
    await enqueue(test.ctx, { queue: "deliver", payload: { n: "paused" }, group: "b.example" });
    await enqueue(test.ctx, {
        queue: "deliver",
        payload: { n: "later" },
        runAt: new Date(start.getTime() + 10 * minute),
    });
    await enqueue(test.ctx, { queue: "fetch", payload: {}, maxAttempts: 1 });
    test.clock.advance(minute);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: "due later" } });

    // The oldest is running, so the one due next is the one due longest.
    await claim(test.ctx, { ...options, limit: 1 });
    const [dying] = await claim(test.ctx, { ...options, queue: "fetch" });
    await giveUp(test.ctx, dying, "invalid");
    await postponeGroup(test.ctx, "deliver", "b.example", new Date(start.getTime() + 20 * minute));

    assertEquals(await queueStats(test.ctx, test.clock.now()), [
        { queue: "deliver", waiting: 5, oldestDue: new Date(start.getTime() + minute), dead: 0 },
        { queue: "fetch", waiting: 0, oldestDue: undefined, dead: 1 },
    ]);
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
    // Without a summary it is retained whole, and while it is retained anyway, so is its key.
    const later = new Date(test.clock.now().getTime() + minute);
    assertEquals(await dead("c", (job) => giveUp(test.ctx, job, "invalid"), later), {
        payload: { body: "large" },
        dedupe_key: "c",
    });

    // A job that will be retried retains both.
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

/** Adds a job per `n` to `queue`, in `group` if given, and gives each up, one minute apart. */
const deadLetter = async (
    test: Awaited<ReturnType<typeof open>>,
    queue: string,
    n: number,
    group?: string,
) => {
    const id = await enqueue(test.ctx, { queue, payload: { n }, group, maxAttempts: 3 });
    assert(id);
    const [job] = await claim(test.ctx, { ...options, queue });
    await giveUp(test.ctx, job, `failure ${n}`);
    test.clock.advance(minute);

    return id;
};

Deno.test("dead letters are listed last died first, a queue's if asked, up to a limit", async () => {
    await using test = await open();
    const died = test.clock.now();
    const first = await deadLetter(test, "deliver", 1);
    await deadLetter(test, "notify", 2);
    await deadLetter(test, "deliver", 3);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 4 } });

    const all = await listDeadLetters(test.ctx, { limit: 10 });
    assertEquals(all.map((job) => job.payload.n), [3, 2, 1]);
    assertEquals(all[2], {
        id: first,
        queue: "deliver",
        payload: { n: 1 },
        attempts: 3,
        last_error: "failure 1",
        created_at: died,
        died_at: died,
    });

    assertEquals(ids(await listDeadLetters(test.ctx, { queue: "deliver", limit: 10 })), [3, 1]);
    assertEquals(ids(await listDeadLetters(test.ctx, { limit: 2 })), [3, 2]);
});

Deno.test("retried dead letters run again from their first attempt, after their group's pause", async () => {
    await using test = await open();
    const { at } = timeAndJobs(test);
    await deadLetter(test, "deliver", 1);
    await deadLetter(test, "deliver", 2, "b.example");
    await deadLetter(test, "deliver", 3, "c.example");
    await deadLetter(test, "notify", 4);
    await enqueue(test.ctx, { queue: "deliver", payload: { n: 5 }, runAt: at(5) });
    await postponeGroup(test.ctx, "deliver", "b.example", at(10));
    await postponeGroup(test.ctx, "notify", "c.example", at(10));

    const heard: string[] = [];
    subscribe(test.ctx, jobWakeups, (queue) => Promise.resolve(void heard.push(queue)));

    assertEquals(await retryDeadLetters(test.ctx, { queue: "deliver" }, 2), 3);
    // Idle workers are woken on SQLite, whose workers run in this process.
    if (testDatabaseKind === "sqlite") assertEquals(heard, ["deliver", "deliver"]);

    const rows = await test.ctx.db.selectFrom("jobs").select(["payload", "attempts", "run_at"])
        .orderBy("created_at").execute();
    assertEquals(rows.map((row) => [row.payload.n, row.attempts, row.run_at]), [
        [1, 0, at(0)],
        [2, 0, at(10)],
        [3, 0, at(0)],
        [4, 3, at(-1)],
        [5, 0, at(5)],
    ]);
    assertEquals(await listDeadLetters(test.ctx, { queue: "deliver", limit: 10 }), []);
});

Deno.test("a retried dead letter waits only for its own queue's pause of its group", async () => {
    await using test = await open();
    const later = new Date(test.clock.now().getTime() + 10 * minute);
    const delivery = await deadLetter(test, "deliver", 1, "b.example");
    const notification = await deadLetter(test, "notify", 2, "b.example");
    await postponeGroup(test.ctx, "deliver", "b.example", later);

    assertEquals(await retryDeadLetters(test.ctx, { ids: [delivery, notification] }), 2);

    const rows = await test.ctx.db.selectFrom("jobs").select("run_at").orderBy("created_at")
        .execute();
    assertEquals(rows.map((row) => row.run_at), [later, test.clock.now()]);
});

Deno.test("only the dead letters given are retried or deleted", async () => {
    await using test = await open();
    const one = await deadLetter(test, "deliver", 1);
    const two = await deadLetter(test, "deliver", 2);
    await deadLetter(test, "deliver", 3);
    const waiting = await enqueue(test.ctx, { queue: "deliver", payload: { n: 4 } });
    assert(waiting);

    assertEquals(await retryDeadLetters(test.ctx, { ids: [one, waiting] }), 1);
    assertEquals(await deleteDeadLetters(test.ctx, { ids: [one, two] }), 1);

    const rows = await test.ctx.db.selectFrom("jobs").select("payload").orderBy("created_at")
        .execute();
    assertEquals(ids(rows), [1, 3, 4]);
    assertEquals(
        await deadLetterQueues(test.ctx, { ids: [one, two, waiting] }),
        new Map(),
    );
});

Deno.test("a queue's dead letters are deleted a batch at a time, until none are left", async () => {
    await using test = await open();
    for (const n of [1, 2, 3, 4, 5]) await deadLetter(test, "deliver", n);
    await deadLetter(test, "notify", 6);

    assertEquals(await deleteDeadLetters(test.ctx, { queue: "deliver" }, 2), 5);

    const rows = await test.ctx.db.selectFrom("jobs").select("payload").execute();
    assertEquals(ids(rows), [6]);
});
