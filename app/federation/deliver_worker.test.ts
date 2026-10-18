import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { enqueue } from "../jobs/queue.ts";
import { drain } from "../jobs/worker.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { type DeliverJob, deliverQueue } from "./deliver.ts";
import { deliverHandler, retryAfter } from "./deliver_worker.ts";

const hour = 60 * 60_000;
const queues = { [deliverQueue]: { handler: deliverHandler, concurrency: 1 } };

/** b.example answering deliveries as `answer` says, and what it was sent. */
const open = async () => {
    const test = await createTestContext();
    let answer = () => new Response(null, { status: 202 });
    const received: Request[] = [];
    test.transport.servers.set("b.example", (request) => {
        received.push(request);
        return answer();
    });

    /** Queues a delivery to b.example and returns its id. */
    const queue = async () => {
        const payload: DeliverJob = { domain: "b.example", body: '{"type": "Thing"}' };
        const id = await enqueue(test.ctx, { queue: deliverQueue, payload, maxAttempts: 100 });
        if (id === undefined) throw new Error("Not queued");
        return id;
    };

    /** The job `id`, or `undefined` once it is done, since finished jobs are deleted. */
    const job = (id: string) =>
        test.ctx.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();

    /** Delivers once, with b.example answering `status` and `headers`, and returns the job. */
    const deliver = async (status: number, headers: HeadersInit = {}) => {
        answer = () => new Response(null, { status, headers });
        const id = await queue();
        await drain(test.ctx, queues);
        return await job(id);
    };

    const outcome = (row: Awaited<ReturnType<typeof job>>) =>
        !row ? "done" : row.attempts === row.max_attempts ? "given up" : "retried";

    return { ...test, received, queue, job, deliver, outcome };
};

Deno.test("an entity is delivered, signed, and its instance takes it in", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const user = await registry.types.get("User")?.find?.(a, alice, "");

    const payload: DeliverJob = { domain: "b.test", body: JSON.stringify(user) };
    await enqueue(a, { queue: deliverQueue, payload });
    await network.drain();

    const saved = await b.db.selectFrom("accounts").select(["username", "remote_id"])
        .where("instance_id", "is not", null).execute();
    assertEquals(saved, [{ username: "alice", remote_id: alice }]);
});

Deno.test("the body is posted as it was queued, to the instance's inbox", async () => {
    await using test = await open();

    await test.deliver(202);

    const [request] = test.received;
    assertEquals([request.method, request.url], ["POST", "https://b.example/.versia/v0.6/inbox"]);
    assertEquals(await request.text(), '{"type": "Thing"}');
    assertEquals(request.headers.get("versia-signed-by"), "social.example");
});

Deno.test("a refusal is given up on, and anything else is retried", async () => {
    await using test = await open();

    for (const status of [200, 202, 204]) {
        assertEquals(test.outcome(await test.deliver(status)), "done", String(status));
    }
    for (const status of [400, 401, 403, 404, 410, 413, 422]) {
        assertEquals(test.outcome(await test.deliver(status)), "given up", String(status));
    }
    for (const status of [301, 408, 429, 500, 502, 503]) {
        assertEquals(test.outcome(await test.deliver(status)), "retried", String(status));
    }

    test.transport.down.add("b.example");
    assertEquals(test.outcome(await test.deliver(202)), "retried");
});

Deno.test("an instance that asks to wait is tried again when it says", async () => {
    await using test = await open();
    const now = test.clock.now().getTime();

    for (const status of [429, 503]) {
        const job = await test.deliver(status, { "retry-after": "120" });
        assertEquals([job?.run_at.getTime(), job?.attempts], [now + 120_000, 0], String(status));
    }

    const date = new Date(now + hour);
    const job = await test.deliver(429, { "retry-after": date.toUTCString() });
    assertEquals(job?.run_at, date);

    // Only those two statuses say when to retry.
    const failed = await test.deliver(500, { "retry-after": "120" });
    assertEquals(failed?.attempts, 1);
});

Deno.test("a delivery is given up on after 48 hours", async () => {
    await using test = await open();
    test.transport.down.add("b.example");
    const id = await test.queue();

    await drain(test.ctx, queues);
    test.clock.advance(47 * hour);
    await drain(test.ctx, queues);
    assertEquals(test.outcome(await test.job(id)), "retried");

    const sent = test.transport.sent.length;
    test.clock.advance(hour);
    await drain(test.ctx, queues);
    assertEquals(test.outcome(await test.job(id)), "given up");
    assertEquals(test.transport.sent.length, sent);

    // Nor does it wait past them when asked.
    test.transport.down.delete("b.example");
    const waited = await test.deliver(503, { "retry-after": String(48 * 60 * 60) });
    assertEquals(test.outcome(waited), "given up");
});

Deno.test("a delivery to an instance blocked since it was queued is dropped", async () => {
    await using test = await open();
    const id = await test.queue();

    await blockDomain(test.ctx, "b.example");
    await drain(test.ctx, queues);

    assertEquals(test.outcome(await test.job(id)), "done");
    assertEquals(test.received, []);
});

Deno.test("Retry-After is read as seconds or a date", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const after = (value: string) => retryAfter(new Headers({ "retry-after": value }), now);

    assertEquals(after("30"), new Date("2026-10-18T12:00:30Z"));
    assertEquals(after(" 0 "), now);
    assertEquals(after("Sun, 18 Oct 2026 13:00:00 GMT"), new Date("2026-10-18T13:00:00Z"));
    assertEquals(after("soon"), undefined);
    assertEquals(after("30 seconds"), undefined);
    assertEquals(after(""), undefined);
    assertEquals(retryAfter(new Headers(), now), undefined);
});
