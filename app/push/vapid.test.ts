import { assertEquals, assertMatch } from "@std/assert";
import { decodeProtectedHeader, jwtVerify } from "@panva/jose";
import { createTestContext } from "../testing/context.ts";
import { vapidKey } from "./keys.ts";
import { vapidAuthorization } from "./vapid.ts";

Deno.test("pushes are signed for the push service, for 12 hours, with the key they name", async () => {
    await using test = await createTestContext();
    const key = await vapidKey(test.ctx);
    const now = new Date("2026-01-01T00:00:00Z");

    const header = await vapidAuthorization(
        key,
        "https://push.example:8443/send/abc?x=1",
        "https://social.example",
        now,
    );

    const [, jwt, shown] = /^vapid t=(\S+), k=(\S+)$/.exec(header) ?? [];
    assertEquals(shown, key.publicKey.toBase64({ alphabet: "base64url", omitPadding: true }));
    assertMatch(shown, /^[A-Za-z0-9_-]+$/);

    const publicKey = await crypto.subtle.importKey(
        "raw",
        Uint8Array.fromBase64(shown, { alphabet: "base64url" }),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );
    const { payload } = await jwtVerify(jwt, publicKey, { currentDate: now });
    assertEquals(payload, {
        aud: "https://push.example:8443",
        exp: now.getTime() / 1000 + 12 * 60 * 60,
        sub: "https://social.example",
    });
    assertEquals(decodeProtectedHeader(jwt), { typ: "JWT", alg: "ES256" });
});
