import { assertEquals } from "@std/assert";
import { importPublicKey, sign, type SignedMessage, verify } from "./signing.ts";

const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
]) as CryptoKeyPair;
const otherKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
]) as CryptoKeyPair;

const message: SignedMessage = {
    method: "POST",
    pathname: "/.versia/v0.6/inbox",
    body: new TextEncoder().encode('{"content":"Hello, world!"}'),
};
const signedAt = new Date("2024-10-18T09:23:37Z");
const headers = new Headers(
    await sign(message, keys.privateKey, "bob.com", signedAt),
);
const keyOfBob = (domain: string) =>
    Promise.resolve(domain === "bob.com" ? keys.publicKey : undefined);

const check = (
    changes: Partial<SignedMessage> = {},
    changedHeaders: Record<string, string | null> = {},
    now = signedAt,
) => {
    const received = new Headers(headers);
    for (const [name, value] of Object.entries(changedHeaders)) {
        if (value === null) received.delete(name);
        else received.set(name, value);
    }
    return verify({ ...message, ...changes }, received, keyOfBob, now);
};

Deno.test("a signed message verifies", async () => {
    assertEquals(headers.get("Versia-Signed-At"), "1729243417");
    assertEquals(await check(), { ok: true, signedBy: "bob.com" });
    assertEquals(await check({ method: "post" }), {
        ok: true,
        signedBy: "bob.com",
    });
});

Deno.test("a changed message is rejected", async () => {
    const invalid = { ok: false, reason: "invalid" } as const;
    assertEquals(await check({ method: "PUT" }), invalid);
    assertEquals(await check({ pathname: "/.versia/v0.6/inbox/" }), invalid);
    assertEquals(
        await check({ body: new TextEncoder().encode("{}") }),
        invalid,
    );
    assertEquals(
        await check({}, { "Versia-Signed-At": "1729243418" }),
        invalid,
    );
    assertEquals(await check({}, { "Versia-Signed-By": "eve.com" }), invalid);
});

Deno.test("signatures are valid for 5 minutes either side", async () => {
    const at = (seconds: number) => new Date(signedAt.getTime() + seconds * 1000);
    assertEquals((await check({}, {}, at(300))).ok, true);
    assertEquals((await check({}, {}, at(-300))).ok, true);
    assertEquals(await check({}, {}, at(301)), {
        ok: false,
        reason: "expired",
    });
    assertEquals(await check({}, {}, at(-301)), {
        ok: false,
        reason: "expired",
    });
    // A timestamp in milliseconds, as the spec's example wrongly uses, is far in the future.
    assertEquals(
        await check({}, { "Versia-Signed-At": signedAt.getTime().toString() }),
        { ok: false, reason: "expired" },
    );
});

Deno.test("the key isn't looked up for an expired signature", async () => {
    let lookedUp = false;
    const result = await verify(message, headers, () => {
        lookedUp = true;
        return Promise.resolve(keys.publicKey);
    }, new Date(signedAt.getTime() + 3_600_000));
    assertEquals(result.ok, false);
    assertEquals(lookedUp, false);
});

Deno.test("missing or malformed headers and unknown keys are rejected", async () => {
    const invalid = { ok: false, reason: "invalid" } as const;
    for (
        const name of [
            "Versia-Signature",
            "Versia-Signed-By",
            "Versia-Signed-At",
        ]
    ) {
        assertEquals(await check({}, { [name]: null }), invalid, name);
    }
    for (const signedAt of ["", "01729243417", "1729243417.0", "+1729243417"]) {
        assertEquals(
            await check({}, { "Versia-Signed-At": signedAt }),
            invalid,
            signedAt,
        );
    }
    assertEquals(
        await check({}, { "Versia-Signature": "not base64!" }),
        invalid,
    );
    assertEquals(
        await verify(
            message,
            headers,
            () => Promise.resolve(otherKeys.publicKey),
            signedAt,
        ),
        invalid,
    );
    assertEquals(
        await verify(
            message,
            headers,
            () => Promise.resolve(undefined),
            signedAt,
        ),
        invalid,
    );
});

Deno.test("public keys are imported from SPKI base64 only", async () => {
    const spki = new Uint8Array(
        await crypto.subtle.exportKey("spki", keys.publicKey),
    );
    const imported = await importPublicKey(spki.toBase64());
    assertEquals(
        await verify(
            message,
            headers,
            () => Promise.resolve(imported),
            signedAt,
        ),
        { ok: true, signedBy: "bob.com" },
    );
    // The raw 32-byte key, without the SPKI wrapping, is a common mistake.
    const raw = new Uint8Array(
        await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    assertEquals(await importPublicKey(raw.toBase64()), undefined);
    assertEquals(await importPublicKey("not base64!"), undefined);
});

Deno.test("the signer is a canonical hostname, checked before any lookup", async () => {
    assertEquals(await check({}, { "Versia-Signed-By": "BOB.com" }), {
        ok: true,
        signedBy: "bob.com",
    });
    for (const signedBy of ["", "bob.com/x", "u@bob.com", "bob.com?x"]) {
        let lookedUp = false;
        const received = new Headers(headers);
        received.set("Versia-Signed-By", signedBy);
        const result = await verify(message, received, () => {
            lookedUp = true;
            return Promise.resolve(keys.publicKey);
        }, signedAt);
        assertEquals(result, { ok: false, reason: "invalid" }, signedBy);
        assertEquals(lookedUp, false, signedBy);
    }
});

Deno.test("short signatures and unusable keys are rejected", async () => {
    const invalid = { ok: false, reason: "invalid" } as const;
    const short = new Uint8Array(32).toBase64();
    assertEquals(await check({}, { "Versia-Signature": short }), invalid);
    // A private key can't verify, so WebCrypto throws; verify still answers.
    assertEquals(
        await verify(
            message,
            headers,
            () => Promise.resolve(keys.privateKey),
            signedAt,
        ),
        invalid,
    );
});
