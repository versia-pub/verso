import { assertEquals } from "@std/assert";
import { fakeClock } from "../kernel/clock.ts";
import { consume, memoryRateLimitStore } from "./rate_limits.ts";

// Shorter than the memory store's sweep, so windows end before a sweep could forget them.
const policy = { limit: 2, windowSeconds: 30 };

Deno.test("requests over the limit are refused until the window ends", async () => {
    const clock = fakeClock();
    const store = memoryRateLimitStore(clock);
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

Deno.test("each key has its own window, starting at its first request", async () => {
    const clock = fakeClock();
    const store = memoryRateLimitStore(clock);

    await consume(store, clock, policy, "a");
    clock.advance(10_000);
    const b = await consume(store, clock, policy, "b");
    const a = await consume(store, clock, policy, "a");

    assertEquals([a.remaining, a.resetSeconds], [0, 20]);
    assertEquals([b.remaining, b.resetSeconds], [1, 30]);
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
