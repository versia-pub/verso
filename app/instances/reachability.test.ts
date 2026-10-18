import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { parkedForMs, parkedUntil, recordReached, recordUnreachable } from "./reachability.ts";
import { createInstance } from "./testing.ts";

const minute = 60_000;

Deno.test("the wait doubles from a minute, after five failures, up to an hour", () => {
    const waits = [5, 6, 7, 8, 9, 10, 11, 20].map((failures) => parkedForMs(failures) / minute);

    assertEquals(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
});

Deno.test("five failures in a row park an instance, and an answer unparks it", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const at = (minutes: number) => new Date(test.clock.now().getTime() + minutes * minute);

    for (let n = 0; n < 4; n++) {
        assertEquals(await recordUnreachable(test.ctx, "b.example"), undefined);
    }
    assertEquals(await parkedUntil(test.ctx, "b.example"), undefined);

    const parked = at(1);
    assertEquals(await recordUnreachable(test.ctx, "b.example"), parked);
    test.clock.advance(minute / 2);
    assertEquals(await parkedUntil(test.ctx, "b.example"), parked);

    assertEquals(await recordReached(test.ctx, "b.example"), true);
    assertEquals(await parkedUntil(test.ctx, "b.example"), undefined);
    assertEquals(await recordReached(test.ctx, "b.example"), false);

    // It starts counting again.
    assertEquals(await recordUnreachable(test.ctx, "b.example"), undefined);
    assertEquals(await recordReached(test.ctx, "b.example"), true);
});

Deno.test("once the wait is over, one probe at a time is let through", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    for (let n = 0; n < 5; n++) await recordUnreachable(test.ctx, "b.example");

    test.clock.advance(minute);
    const held = new Date(test.clock.now().getTime() + minute);
    const asked = await Promise.all([1, 2, 3].map(() => parkedUntil(test.ctx, "b.example")));
    assertEquals(asked.toSorted(), [held, held, undefined]);
    assertEquals(await parkedUntil(test.ctx, "b.example"), held);

    // The probe failing waits twice as long.
    assertEquals(
        await recordUnreachable(test.ctx, "b.example"),
        new Date(test.clock.now().getTime() + 2 * minute),
    );
});

Deno.test("an instance Verso doesn't know is never parked", async () => {
    await using test = await createTestContext();

    for (let n = 0; n < 5; n++) {
        assertEquals(await recordUnreachable(test.ctx, "b.example"), undefined);
    }
    assertEquals(await parkedUntil(test.ctx, "b.example"), undefined);
    assertEquals(await recordReached(test.ctx, "b.example"), false);
});
