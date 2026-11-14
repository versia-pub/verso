import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { fakeClock } from "./clock.ts";
import { countingRandom, firstIdAt, idGenerator } from "./ids.ts";

const idFormat = /^[0-9a-hjkmnp-tv-z]{18}$/;

Deno.test("ids are 18 lowercase base32 characters", () => {
    const nextId = idGenerator(fakeClock());

    for (let i = 0; i < 100; i++) assertMatch(nextId(), idFormat);
});

Deno.test("ids start with the clock's time", () => {
    // RFC 9562's example timestamp: Tuesday, February 22, 2022 2:22:22.00 PM GMT-05:00.
    const clock = fakeClock(new Date(0x017F22E279B0));
    const id = idGenerator(clock)();

    // The time is 42 bits. Its first 40 are the first 8 characters, and the 9th starts with the rest.
    assertEquals(id.slice(0, 8), "bz4bh7kc");
});

Deno.test("an id holds the time, the node id and the counter, which wraps to 0", () => {
    const bytes = [0xab, 0xcd, 0xee, 0xff, 0xff, 0xff];
    const nextId = idGenerator(fakeClock(new Date(0x017F22E279B0)), (array) => array.set(bytes));

    assertEquals([nextId(), nextId()], ["bz4bh7kc5bsqqfzzzz", "bz4bh7kc5bsqq00000"]);
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

Deno.test("ids made in one millisecond sort in the order they were made and differ", () => {
    const nextId = idGenerator(fakeClock(), countingRandom());

    const ids = Array.from({ length: 100 }, () => nextId());

    assertEquals(ids.toSorted(), ids);
    assertEquals(new Set(ids).size, 100);
});

Deno.test("an id can be backdated", () => {
    const nextId = idGenerator(fakeClock());
    const at = new Date("2020-05-05T05:05:05.005Z");

    const id = nextId(at);

    assert(id >= firstIdAt(at) && id < firstIdAt(new Date(at.getTime() + 1)));
    assert(id < nextId());
});

Deno.test("a time out of range is refused", () => {
    const nextId = idGenerator(fakeClock());

    assertEquals(nextId(new Date(0)).slice(0, 8), "00000000");
    assertEquals(nextId(new Date(2 ** 42 - 1)).slice(0, 8), "zzzzzzzz");

    assertThrows(() => nextId(new Date(-1)), RangeError);
    assertThrows(() => nextId(new Date(2 ** 42)), RangeError);
    assertThrows(() => nextId(new Date(Number.NaN)), RangeError);
});

Deno.test("the first id at a time sorts before every id made then or later, and after earlier ones", () => {
    const time = new Date("2026-01-01T00:00:00Z");
    const first = firstIdAt(time);

    assertMatch(first, idFormat);

    const nextId = idGenerator(fakeClock(time), (bytes) => bytes.fill(0xff));
    const earlier = idGenerator(
        fakeClock(new Date(time.getTime() - 1)),
        (bytes) => bytes.fill(0xff),
    );

    const ids = [earlier(), first, nextId()];

    assertEquals(ids.toSorted(), ids);
    assertEquals(first.slice(9), "000000000");
});

Deno.test("random ids made at the same time differ", () => {
    assertNotEquals(idGenerator(fakeClock())(), idGenerator(fakeClock())());
});

Deno.test("a counting random source gives the same ids on every run", () => {
    const ids = () => {
        const nextId = idGenerator(fakeClock(), countingRandom());
        return [nextId(), nextId()];
    };

    assertEquals(ids().map((id) => id.slice(9)), ["000000001", "000000002"]);
    assertEquals(ids(), ids());
});

Deno.test("the fake clock only moves when told to", () => {
    const clock = fakeClock(new Date("2026-01-01T00:00:00Z"));

    assertEquals(clock.now().toISOString(), "2026-01-01T00:00:00.000Z");

    clock.advance(1500);
    assertEquals(clock.now().toISOString(), "2026-01-01T00:00:01.500Z");
});
