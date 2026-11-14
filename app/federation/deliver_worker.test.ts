import { assertEquals } from "@std/assert";
import { v0_7 } from "@versia/protocol";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { createInstance, keyPair } from "../instances/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { drain } from "../jobs/worker.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import type { Settings } from "../kernel/settings.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { type DeliverJob, deliverQueue } from "./deliver.ts";
import { deliveryOf } from "./testing.ts";
import { deliverDeadPayload, deliverHandler, retryAfter } from "./deliver_worker.ts";
import { requestTarget } from "./request.ts";

const minute = 60_000;
const hour = 60 * minute;
const queues = { [deliverQueue]: { handler: deliverHandler, concurrency: 1 } };

/**
 * b.example answering deliveries as `answer` says, signed unless `signs` is false, and recording
 * what it received.
 */
const open = async (settings: Partial<Settings> = {}) => {
    const test = await createTestContext({ settings });
    await createInstance(test.ctx, "b.example");
    const pair = await keyPair();
    // Its key is known, so checking its replies doesn't fetch it.
    await test.ctx.db.updateTable("instances").set({ public_key: pair.spki })
        .where("domain", "=", "b.example").execute();

    let answer = () => new Response(null, { status: 202 });
    let signs = true;
    const received: Request[] = [];
    test.transport.servers.set("b.example", async (request) => {
        received.push(request);

        const reply = answer();
        if (!signs) return reply;

        const body = new Uint8Array(await reply.arrayBuffer());
        const headers = await v0_7.sign(
            {
                method: request.method,
                host: "b.example",
                target: requestTarget(new URL(request.url)),
                body,
            },
            pair.privateKey,
            "b.example",
            test.clock.now(),
        );

        // A body is not allowed on some statuses, like 204.
        return new Response(body.length === 0 ? null : body, {
            status: reply.status,
            headers: { ...Object.fromEntries(reply.headers), ...headers },
        });
    });

    /** Queues a delivery to b.example and returns its id. */
    const queue = async (payload?: DeliverJob) => {
        payload ??= await deliveryOf(test.ctx, "b.example", '{"type": "Thing"}');
        const id = await enqueue(test.ctx, {
            queue: deliverQueue,
            payload,
            maxAttempts: 100,
            group: "b.example",
        });
        if (id === undefined) throw new Error("Not queued");

        return id;
    };

    /** The job `id`, or `undefined` once it is done, since finished jobs are deleted. */
    const job = (id: string) =>
        test.ctx.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();

    /**
     * Delivers once, with b.example answering with `status` and `headers`, signed unless `signed`
     * is false, and returns the job.
     */
    const deliver = async (status: number, headers: HeadersInit = {}, signed = true) => {
        answer = () => new Response(null, { status, headers });
        signs = signed;
        const id = await queue();
        await drain(test.ctx, queues);

        return await job(id);
    };

    const outcome = (row: Awaited<ReturnType<typeof job>>) =>
        !row ? "done" : row.attempts === row.max_attempts ? "given up" : "retried";

    const failures = async () =>
        (await test.ctx.db.selectFrom("instances").select("failures").executeTakeFirstOrThrow())
            .failures;

    return { ...test, received, queue, job, deliver, outcome, failures };
};

Deno.test("an entity is delivered, signed, and its instance takes it in", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    await b.federation.resolve(b, { host: "a.test", id: alice }, "User");

    await updateProfile(a, alice, { displayName: "Alice" });
    const user = await registry.types.get("User")?.find?.(a, alice, "");
    const payload = await deliveryOf(a, "b.test", JSON.stringify(user));
    await enqueue(a, { queue: deliverQueue, payload });
    await network.drain();

    const saved = await b.db.selectFrom("accounts").select(["display_name", "remote_id"])
        .where("instance_id", "is not", null).execute();
    assertEquals(saved, [{ display_name: "Alice", remote_id: alice }]);
});

Deno.test("the body is posted as it was queued, to the instance's inbox", async () => {
    await using test = await open();

    await test.deliver(202);

    const [request] = test.received;
    assertEquals([request.method, request.url], ["POST", "https://b.example/.versia/v0.7/inbox"]);
    assertEquals(await request.text(), '{"type": "Thing"}');
    assertEquals(request.headers.get("versia-signed-by"), "social.example");
});

Deno.test("a refusal is given up on, and anything else is retried, but a 401", async () => {
    await using test = await open();

    for (const status of [200, 202, 204]) {
        assertEquals(test.outcome(await test.deliver(status)), "done", String(status));
    }
    for (const status of [400, 403, 404, 410, 413, 422]) {
        assertEquals(test.outcome(await test.deliver(status)), "given up", String(status));
    }
    for (const status of [301, 401, 408, 429, 500, 502, 503]) {
        assertEquals(test.outcome(await test.deliver(status)), "retried", String(status));
    }

    test.transport.down.add("b.example");
    assertEquals(test.outcome(await test.deliver(202)), "retried");
});

Deno.test("a 2xx the instance didn't sign isn't a delivery, so it is retried", async () => {
    await using test = await open();

    assertEquals(test.outcome(await test.deliver(202, {}, false)), "retried");
    assertEquals(test.outcome(await test.deliver(204, {}, false)), "retried");
    assertEquals(test.outcome(await test.deliver(202)), "done");

    // It answered, so it is up.
    assertEquals(await test.failures(), 0);
});

Deno.test("a reply signed over another request isn't a delivery", async () => {
    await using test = await open();
    const other = await keyPair();
    // Signed with a key that isn't the one Verso has for b.example.
    test.transport.servers.set("b.example", async (request) => {
        const body = new Uint8Array();
        const headers = await v0_7.sign(
            {
                method: "POST",
                host: "b.example",
                target: requestTarget(new URL(request.url)),
                body,
            },
            other.privateKey,
            "b.example",
            test.clock.now(),
        );

        return new Response(null, { status: 202, headers });
    });
    const id = await test.queue();

    await drain(test.ctx, queues);

    assertEquals(test.outcome(await test.job(id)), "retried");
});

Deno.test("an instance that asks to wait is tried again when it says", async () => {
    for (const status of [429, 503, 500, 401, 408]) {
        await using test = await open();
        const now = test.clock.now().getTime();

        const job = await test.deliver(status, { "retry-after": "120" });

        assertEquals([job?.run_at.getTime(), job?.attempts], [now + 120_000, 0], String(status));
    }

    // Also when it accepted the delivery without signing the reply.
    await using unsigned = await open();
    const now = unsigned.clock.now().getTime();
    const discarded = await unsigned.deliver(202, { "retry-after": "120" }, false);
    assertEquals([discarded?.run_at.getTime(), discarded?.attempts], [now + 120_000, 0]);

    await using test = await open();
    const date = new Date(test.clock.now().getTime() + hour);
    const job = await test.deliver(429, { "retry-after": date.toUTCString() });
    assertEquals(job?.run_at, date);

    // Without one, a failure is retried by the queue's own backoff.
    await using other = await open();
    const failed = await other.deliver(500);
    assertEquals(failed?.attempts, 1);
});

Deno.test("an instance that asks to wait gets no deliveries until then", async () => {
    await using test = await open();
    const now = test.clock.now().getTime();
    const pausedUntil = async () =>
        (await test.ctx.db.selectFrom("job_pauses").select("until").executeTakeFirst())?.until
            .getTime();

    const waiting = [await test.queue(), await test.queue()];
    const job = await test.deliver(429, { "retry-after": "120" });
    assertEquals(test.received.length, 1);
    assertEquals(await pausedUntil(), now + 120_000);
    // Queued since, it waits too.
    await test.deliver(202);
    assertEquals(test.received.length, 1);

    // Its rate limit headers aren't read, so they don't pause it.
    test.clock.advance(120_000);
    await test.deliver(202, { "ratelimit-remaining": "0", "ratelimit-reset": "60" });
    // The three postponed, the one queued since, and this one.
    assertEquals(test.received.length, 6);
    assertEquals(await test.job(waiting[0]), undefined);
    assertEquals(await test.job(job?.id ?? ""), undefined);
});

Deno.test("an instance that can't be reached is left alone, but for a probe", async () => {
    await using test = await open();
    test.transport.down.add("b.example");
    const ids = [];
    for (let n = 0; n < 6; n++) ids.push(await test.queue());
    const sent = () => test.transport.sent.length;

    // Five failures park the instance, and the sixth delivery waits without being tried.
    await drain(test.ctx, queues);
    assertEquals(sent(), 5);
    assertEquals((await test.job(ids[5]))?.last_error, null);

    // Deliveries queued in the meantime wait too, without being tried.
    ids.push(await test.queue(), await test.queue());
    await drain(test.ctx, queues);
    assertEquals(sent(), 5);
    assertEquals((await test.job(ids[6]))?.last_error, null);

    // After a minute, one probe, which fails, so the next wait is two minutes.
    test.clock.advance(minute);
    await drain(test.ctx, queues);
    assertEquals(sent(), 6);
    test.clock.advance(minute);
    await drain(test.ctx, queues);
    assertEquals(sent(), 6);

    // Once a probe gets through, every delivery goes, even one waiting out a long backoff.
    const payload = await deliveryOf(test.ctx, "b.example", "{}");
    const runAt = new Date(test.clock.now().getTime() + hour);
    ids.push(
        await enqueue(test.ctx, { queue: deliverQueue, payload, group: "b.example", runAt }) ??
            "",
    );
    test.transport.down.delete("b.example");
    test.clock.advance(minute);
    await drain(test.ctx, queues);
    assertEquals(sent(), 15);
    assertEquals(await Promise.all(ids.map((id) => test.job(id))), Array(9).fill(undefined));
    assertEquals(await test.failures(), 0);
});

Deno.test("only a server's failures count against an instance", async () => {
    await using test = await open();

    for (const status of [500, 502, 503, 408]) await test.deliver(status);
    assertEquals(await test.failures(), 4);

    await test.deliver(404);
    assertEquals(await test.failures(), 0);

    for (const status of [400, 429, 301, 202]) await test.deliver(status);
    assertEquals(await test.failures(), 0);
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

Deno.test("a delivery is given up on after as long as settings say", async () => {
    await using test = await open({ deliveryMs: 2 * hour });
    test.transport.down.add("b.example");
    const id = await test.queue();
    await drain(test.ctx, queues);

    test.clock.advance(2 * hour);
    await drain(test.ctx, queues);

    const job = await test.job(id);
    assertEquals(test.outcome(job), "given up");
    assertEquals(job?.last_error?.includes("couldn't be reached in 2 hours"), true);
});

Deno.test("a delivery is given up on by when its entity was queued, not when it was", async () => {
    await using test = await open();
    test.transport.down.add("b.example");
    const payload = await deliveryOf(test.ctx, "b.example", "{}");

    test.clock.advance(47 * hour);
    const id = await test.queue(payload);
    await drain(test.ctx, queues);
    assertEquals(test.outcome(await test.job(id)), "retried");

    test.clock.advance(hour);
    await drain(test.ctx, queues);
    assertEquals(test.outcome(await test.job(id)), "given up");
});

Deno.test("a delivery whose entity is gone is given up on, without sending anything", async () => {
    await using test = await open();
    const id = await test.queue();

    await test.ctx.db.deleteFrom("delivery_bodies").execute();
    await drain(test.ctx, queues);

    assertEquals(test.outcome(await test.job(id)), "given up");
    assertEquals(test.received, []);
});

Deno.test("a delivery queued with its entity, as before entities were stored once, is sent", async () => {
    await using test = await open();
    const id = await test.queue({ domain: "b.example", body: '{"type": "Old"}' });

    await drain(test.ctx, queues);

    assertEquals(test.outcome(await test.job(id)), "done");
    assertEquals(await test.received[0].text(), '{"type": "Old"}');
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

Deno.test("a dead delivery keeps the instance it was for, without the entity", () => {
    assertEquals(deliverDeadPayload({ domain: "b.example", bodyId: "1" }), { domain: "b.example" });
    assertEquals(deliverDeadPayload({ domain: "b.example", body: "{}" }), { domain: "b.example" });
    assertEquals(deliverDeadPayload({ bodyId: "1" }), {});
});
