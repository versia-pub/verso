import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { fakeClock } from "./clock.ts";
import { countingRandom, firstIdAt, idGenerator } from "./ids.ts";

const uuidv7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("ids are UUIDv7 with the clock's time in front", () => {
    // RFC 9562's example timestamp: Tuesday, February 22, 2022 2:22:22.00 PM GMT-05:00.
    const clock = fakeClock(new Date(0x017F22E279B0));
    const id = idGenerator(clock)();

    assertMatch(id, uuidv7);
    assertEquals(id.slice(0, 13), "017f22e2-79b0");
});

Deno.test("ids sort by time", () => {
    const clock = fakeClock();
    const nextId = idGenerator(clock);

    const ids = Array.from({ length: 100 }, () => {
        clock.advance(1);
        return nextId();
    });

    assertEquals(ids.toSorted(), ids);
});

Deno.test("the first id at a time sorts before every id made then or later, and after earlier ones", () => {
    const time = new Date("2026-01-01T00:00:00Z");
    const first = firstIdAt(time);
    assertEquals(first, "019b76da-a800-7000-8000-000000000000");

    const clock = fakeClock(time);
    const nextId = idGenerator(clock, (bytes) => bytes.fill(0xff));
    const earlier = idGenerator(
        fakeClock(new Date(time.getTime() - 1)),
        (bytes) => bytes.fill(0xff),
    );
    assertEquals([earlier(), first, nextId()].toSorted(), [earlier(), first, nextId()]);
});

Deno.test("random ids made at the same time differ", () => {
    const nextId = idGenerator(fakeClock());

    assertNotEquals(nextId(), nextId());
});

Deno.test("a counting random source gives the same ids on every run", () => {
    const ids = () => {
        const nextId = idGenerator(fakeClock(), countingRandom());
        return [nextId(), nextId()];
    };

    assertEquals(ids(), [
        "019b76da-a800-7000-8000-000000000001",
        "019b76da-a800-7000-8000-000000000002",
    ]);
    assertEquals(ids(), ids());
});

Deno.test("the fake clock only moves when told to", () => {
    const clock = fakeClock(new Date("2026-01-01T00:00:00Z"));

    assertEquals(clock.now().toISOString(), "2026-01-01T00:00:00.000Z");

    clock.advance(1500);
    assertEquals(clock.now().toISOString(), "2026-01-01T00:00:01.500Z");
});
