import { assertEquals, assertRejects } from "@std/assert";
import { cached } from "./cache.ts";
import { fakeClock } from "./clock.ts";

const open = () => {
    const ctx = { clock: fakeClock() };
    let loads = 0;
    let fail = false;
    const value = cached(1000, () => {
        loads += 1;
        return fail ? Promise.reject(new Error("down")) : Promise.resolve(loads);
    });

    return {
        ctx,
        value,
        loads: () => loads,
        failing: (failing: boolean) => {
            fail = failing;
        },
    };
};

Deno.test("a value is kept for as long as asked, then worked out again", async () => {
    const test = open();

    assertEquals(await test.value.get(test.ctx), 1);
    test.ctx.clock.advance(999);
    assertEquals(await test.value.get(test.ctx), 1);
    test.ctx.clock.advance(1);
    assertEquals(await test.value.get(test.ctx), 2);
});

Deno.test("a value cleared is worked out again at once", async () => {
    const test = open();
    await test.value.get(test.ctx);

    test.value.clear();

    assertEquals(await test.value.get(test.ctx), 2);
});

Deno.test("gets while a value is worked out share it", async () => {
    const test = open();

    assertEquals(await Promise.all([test.value.get(test.ctx), test.value.get(test.ctx)]), [1, 1]);
    assertEquals(test.loads(), 1);
});

Deno.test("a value that couldn't be worked out isn't kept", async () => {
    const test = open();
    test.failing(true);
    await assertRejects(() => test.value.get(test.ctx));

    test.failing(false);

    assertEquals(await test.value.get(test.ctx), 2);
});

Deno.test("a load that fails after the value was cleared leaves the newer value kept", async () => {
    const ctx = { clock: fakeClock() };
    let fail: (error: Error) => void = () => {};
    let loads = 0;
    const value = cached(1000, () => {
        loads += 1;
        return loads === 1
            ? new Promise<number>((_, reject) => {
                fail = reject;
            })
            : Promise.resolve(loads);
    });
    const failed = value.get(ctx);
    value.clear();
    assertEquals(await value.get(ctx), 2);

    fail(new Error("down"));
    await assertRejects(() => failed);

    assertEquals([await value.get(ctx), loads], [2, 2]);
});
