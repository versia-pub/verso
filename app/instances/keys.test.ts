import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { importPublicKey, sign, verify } from "@versia/protocol";
import { createTestContext } from "../testing/context.ts";
import type { InstanceKey } from "../kernel/context.ts";
import { createInstanceKey, ensureInstanceKey, instanceKey, rotateInstanceKey } from "./keys.ts";

const message = { method: "GET", pathname: "/.versia/v0.6/instance", body: new Uint8Array() };
const now = new Date("2026-01-01T00:00:00Z");

/** Whether the key's private half signs what its public half verifies. */
const isPair = async (key: InstanceKey) => {
    const headers = new Headers(await sign(message, key.privateKey, "a.example", now));
    const publicKey = await importPublicKey(key.publicKey);

    return (await verify(message, headers, () => Promise.resolve(publicKey), now)).ok;
};

Deno.test("each instance has its own key, which signs what its public key verifies", async () => {
    await using a = await createTestContext();
    await using b = await createTestContext();
    const key = await instanceKey(a.ctx);

    assert(await isPair(key));
    assertNotEquals((await instanceKey(b.ctx)).publicKey, key.publicKey);
});

Deno.test("the first key is only made once", async () => {
    await using test = await createTestContext();
    const before = await instanceKey(test.ctx);

    assertEquals(await ensureInstanceKey(test.ctx), false);
    assertEquals((await instanceKey(test.ctx)).publicKey, before.publicKey);
});

Deno.test("a new key is current from then on, also inside a transaction", async () => {
    await using test = await createTestContext();
    const before = await instanceKey(test.ctx);
    test.clock.advance(1000);

    const during = await test.ctx.transaction(async (tx) => {
        await createInstanceKey(tx);
        return await instanceKey(tx);
    });

    const after = await instanceKey(test.ctx);

    assertNotEquals(during.publicKey, before.publicKey);
    assertEquals(after.publicKey, during.publicKey);
    assert(await isPair(after));
});

Deno.test("without a key, using it says how to make one", async () => {
    await using test = await createTestContext();
    await test.ctx.db.deleteFrom("instance_keys").execute();

    const error = await assertRejects(() => instanceKey(test.ctx), Error);
    assert(error.message.includes("verso migrate"));
});

Deno.test("the key is kept for a minute, but a rotation here applies at once", async () => {
    await using test = await createTestContext();
    const kept = () => test.ctx.federation.instanceKey(test.ctx);
    const first = await kept();

    // As the CLI rotates it, from a process of its own.
    test.clock.advance(1000);
    await createInstanceKey(test.ctx);
    test.clock.advance(60_000 - 1000 - 1);
    assertEquals((await kept()).publicKey, first.publicKey);
    test.clock.advance(1);
    const second = await kept();
    assertNotEquals(second.publicKey, first.publicKey);

    test.clock.advance(1000);
    const rotated = await rotateInstanceKey(test.ctx);
    assertEquals((await kept()).publicKey, rotated);
});
