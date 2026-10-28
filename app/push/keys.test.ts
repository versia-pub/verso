import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { ensureVapidKey, vapidKey, vapidPublicKey } from "./keys.ts";

const signature = { name: "ECDSA", hash: "SHA-256" };

Deno.test("each instance has its own VAPID key, which signs what its public key verifies", async () => {
    await using a = await createTestContext();
    await using b = await createTestContext();
    const key = await vapidKey(a.ctx);

    const message = new TextEncoder().encode("Hi");
    const signed = await crypto.subtle.sign(signature, key.privateKey, message);
    const publicKey = await crypto.subtle.importKey(
        "raw",
        key.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );

    assert(await crypto.subtle.verify(signature, publicKey, signed, message));
    assertNotEquals(await vapidPublicKey(b.ctx), await vapidPublicKey(a.ctx));
});

Deno.test("clients are shown the VAPID public key as an uncompressed point in URL-safe base64", async () => {
    await using test = await createTestContext();
    const shown = await vapidPublicKey(test.ctx);

    // 65 bytes, padded, as Mastodon shows it.
    assertMatch(shown, /^[A-Za-z0-9_-]{87}=$/);
    assertEquals(
        Uint8Array.fromBase64(shown, { alphabet: "base64url" }),
        (await vapidKey(test.ctx)).publicKey,
    );
    assertEquals((await vapidKey(test.ctx)).publicKey[0], 4);
});

Deno.test("the VAPID key is only made once, and is needed", async () => {
    await using test = await createTestContext();
    const before = await vapidPublicKey(test.ctx);

    assertEquals(await ensureVapidKey(test.ctx), false);
    assertEquals(await vapidPublicKey(test.ctx), before);

    await test.ctx.db.deleteFrom("vapid_keys").execute();
    await assertRejects(() => vapidKey(test.ctx), Error, "Run `verso migrate`");
    assertEquals(await ensureVapidKey(test.ctx), true);
    assertNotEquals(await vapidPublicKey(test.ctx), before);
});
