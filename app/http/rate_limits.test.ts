import { assertEquals } from "@std/assert";
import { z } from "zod";
import { tokenFor } from "../auth/testing.ts";
import { type FakeClock, fakeClock } from "../kernel/clock.ts";
import { CidrText } from "../kernel/ip.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createApp } from "./app.ts";
import { defineRoute } from "./route.ts";
import {
    consume,
    databaseRateLimitStore,
    deleteEndedRateLimits,
    memoryRateLimitStore,
    type RateLimitStore,
} from "./rate_limits.ts";

// Shorter than the memory store's sweep, so windows end before a sweep could forget them.
const policy = { limit: 2, windowSeconds: 30 };

/** A store, and the clock it runs on. */
type Subject = AsyncDisposable & { readonly store: RateLimitStore; readonly clock: FakeClock };

const stores: Record<string, () => Promise<Subject>> = {
    memory: () => {
        const clock = fakeClock();
        return Promise.resolve({
            store: memoryRateLimitStore(clock),
            clock,
            [Symbol.asyncDispose]: () => Promise.resolve(),
        });
    },
    database: async () => {
        const test = await createTestContext();
        return { ...test, store: databaseRateLimitStore(test.ctx) };
    },
};

for (const [name, open] of Object.entries(stores)) {
    Deno.test(`${name}: requests over the limit are refused until the window ends`, async () => {
        await using subject = await open();
        const { store, clock } = subject;
        const take = () => consume(store, clock, policy, "client");

        assertEquals(await take(), {
            allowed: true,
            limit: 2,
            remaining: 1,
            resetSeconds: 30,
            windowSeconds: 30,
        });
        clock.advance(10_500);
        assertEquals((await take()).remaining, 0);

        const refused = await take();
        assertEquals([refused.allowed, refused.remaining, refused.resetSeconds], [false, 0, 20]);

        clock.advance(19_500);
        assertEquals([(await take()).allowed, (await take()).remaining], [true, 0]);
    });

    Deno.test(`${name}: each key has its own window, starting at its first request`, async () => {
        await using subject = await open();
        const { store, clock } = subject;

        await consume(store, clock, policy, "a");
        clock.advance(10_000);
        const b = await consume(store, clock, policy, "b");
        const a = await consume(store, clock, policy, "a");

        assertEquals([a.remaining, a.resetSeconds], [0, 20]);
        assertEquals([b.remaining, b.resetSeconds], [1, 30]);
    });

    Deno.test(`${name}: requests at the same moment are each counted once`, async () => {
        await using subject = await open();
        const hits = await Promise.all(
            Array.from({ length: 20 }, () => subject.store.hit("client", 30_000)),
        );

        assertEquals(
            hits.map((hit) => hit.count).sort((a, b) => a - b),
            [...Array(20).keys()].map((i) => i + 1),
        );
        assertEquals(new Set(hits.map((hit) => hit.resetsAt.getTime())).size, 1);
    });
}

Deno.test("the database store's ended windows are deleted", async () => {
    await using test = await createTestContext();
    const store = databaseRateLimitStore(test.ctx);

    await store.hit("short", 1_000);
    await store.hit("long", 120_000);
    test.clock.advance(60_000);
    await deleteEndedRateLimits(test.ctx);

    const keys = await test.ctx.db.selectFrom("rate_limits").select("key").execute();
    assertEquals(keys, [{ key: "long" }]);
});

Deno.test("the memory store forgets windows that have ended", async () => {
    const clock = fakeClock();
    const store = memoryRateLimitStore(clock);

    await store.hit("short", 1_000);
    await store.hit("long", 120_000);
    clock.advance(60_000);
    await store.hit("new", 1_000);

    assertEquals(store.size, 2);
});

const ping = defineRoute({
    method: "GET",
    path: "/api/v1/ping",
    summary: "Answers anyone",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

/** An app allowing two requests every 30 seconds, behind a proxy at 10.0.0.1. */
const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, [ping], {
        rateLimits: { store: memoryRateLimitStore(test.clock), policy },
        trustedProxies: [CidrText.parse("10.0.0.1")],
    });

    /** The status of a request from `peer`, with these headers. */
    const status = async (peer: string, headers: Record<string, string> = {}) => {
        const response = await app.request("/api/v1/ping", { headers }, {
            remoteAddr: { hostname: peer },
        });
        await response.body?.cancel();
        return response.status;
    };

    return { ...test, app, status };
};

Deno.test("replies say how much of the quota is left, and when it is gone", async () => {
    await using test = await open();
    const request = () =>
        test.app.request("/api/v1/ping", {}, { remoteAddr: { hostname: "203.0.113.9" } });

    const first = await request();
    await first.body?.cancel();
    assertEquals(first.headers.get("ratelimit-limit"), "2, 2;w=30");
    assertEquals(first.headers.get("ratelimit-remaining"), "1");
    assertEquals(first.headers.get("ratelimit-reset"), "30");

    test.clock.advance(5_000);
    await (await request()).body?.cancel();
    const refused = await request();

    assertEquals(refused.status, 429);
    assertEquals(await refused.json(), { error: "Too many requests" });
    assertEquals(refused.headers.get("ratelimit-remaining"), "0");
    assertEquals(refused.headers.get("retry-after"), "25");
    assertEquals(refused.headers.get("ratelimit-reset"), "25");
    assertEquals(refused.headers.get("access-control-allow-origin"), "*");
});

Deno.test("clients are told apart by IP, through trusted proxies only", async () => {
    await using test = await open();

    for (let i = 0; i < 2; i++) await test.status("203.0.113.9");
    assertEquals(await test.status("203.0.113.9"), 429);
    assertEquals(await test.status("203.0.113.10"), 200);

    // Naming a client only counts against it when a trusted proxy does it.
    const forwarded = { "x-forwarded-for": "203.0.113.9" };
    assertEquals(await test.status("203.0.113.11", forwarded), 200);
    assertEquals(await test.status("10.0.0.1", forwarded), 429);
});

Deno.test("an IPv6 /64 counts as one client", async () => {
    await using test = await open();

    await test.status("2001:db8:0:1::1");
    await test.status("2001:db8:0:1::2");

    assertEquals(await test.status("2001:db8:0:1:ffff::3"), 429);
    assertEquals(await test.status("2001:db8:0:2::1"), 200);
});

Deno.test("a valid token has its own quota, and a made-up one doesn't", async () => {
    await using test = await open();
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    await test.status("203.0.113.9", bearer("made-up-1"));
    await test.status("203.0.113.9", bearer("made-up-2"));
    assertEquals(await test.status("203.0.113.9", bearer("made-up-3")), 429);

    const token = await tokenFor(test.ctx, null);
    for (let i = 0; i < 2; i++) {
        assertEquals(await test.status("203.0.113.9", bearer(token)), 200);
    }
    assertEquals(await test.status("198.51.100.1", bearer(token)), 429);
});

Deno.test("health checks are never limited", async () => {
    await using test = await open();

    for (let i = 0; i < 3; i++) {
        const response = await test.app.request("/health/live");
        assertEquals([response.status, await response.text()], [200, "ok"]);
    }
});
