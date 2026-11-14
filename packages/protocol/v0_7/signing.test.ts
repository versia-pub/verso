import { assertEquals } from "@std/assert";
import { sign, type SignedMessage, verify } from "./signing.ts";

const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;

const message: SignedMessage = {
    method: "POST",
    host: "alice.example",
    target: "/.versia/v0.7/inbox",
    body: new TextEncoder().encode('{"content":"Hello, world!"}'),
};
const signedAt = new Date("2024-10-18T09:23:37Z");
const headers = new Headers(await sign(message, keys.privateKey, "bob.example", signedAt));

const keyOfBob = (domain: string) =>
    Promise.resolve(domain === "bob.example" ? keys.publicKey : undefined);

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

const invalid = { ok: false } as const;

Deno.test("a signed message verifies, whatever the method's case", async () => {
    assertEquals(headers.get("Versia-Signed-At"), "1729243417");
    assertEquals(await check(), { ok: true, signedBy: "bob.example" });
    assertEquals(await check({ method: "post" }), { ok: true, signedBy: "bob.example" });
});

Deno.test("a change to any signed part is rejected", async () => {
    assertEquals(await check({ method: "PUT" }), invalid);
    assertEquals(await check({ host: "carol.example" }), invalid);
    assertEquals(await check({ target: "/.versia/v0.7/inbox/" }), invalid);
    assertEquals(await check({ target: "/.versia/v0.7/inbox?" }), invalid);
    assertEquals(await check({ target: "/.versia/v0.7/inbox?a=1" }), invalid);
    assertEquals(await check({ body: new TextEncoder().encode("{}") }), invalid);
    assertEquals(await check({}, { "Versia-Signed-At": "1729243418" }), invalid);
    assertEquals(await check({}, { "Versia-Signed-By": "eve.example" }), invalid);
});

Deno.test("signatures are valid for 5 minutes either side", async () => {
    const at = (seconds: number) => new Date(signedAt.getTime() + seconds * 1000);

    assertEquals((await check({}, {}, at(300))).ok, true);
    assertEquals((await check({}, {}, at(-300))).ok, true);
    assertEquals(await check({}, {}, at(301)), invalid);
    assertEquals(await check({}, {}, at(-301)), invalid);
    assertEquals(
        await check({}, { "Versia-Signed-At": signedAt.getTime().toString() }),
        invalid,
    );
});

Deno.test("the key isn't looked up for a stale signature", async () => {
    let lookedUp = false;

    const result = await verify(message, headers, () => {
        lookedUp = true;
        return Promise.resolve(keys.publicKey);
    }, new Date(signedAt.getTime() + 3_600_000));

    assertEquals(result, invalid);
    assertEquals(lookedUp, false);
});

Deno.test("missing or malformed headers and unknown keys are rejected", async () => {
    for (const name of ["Versia-Signature", "Versia-Signed-By", "Versia-Signed-At"]) {
        assertEquals(await check({}, { [name]: null }), invalid, name);
    }

    for (const value of ["", "01729243417", "1729243417.0", "+1729243417", "-1"]) {
        assertEquals(await check({}, { "Versia-Signed-At": value }), invalid, value);
    }

    const signature = headers.get("Versia-Signature") ?? "";
    for (
        const value of [
            signature.slice(0, -2),
            // Headers trims spaces at either end, so put one inside.
            `${signature.slice(0, 40)} ${signature.slice(41)}`,
            signature.replaceAll("+", "-").replaceAll("/", "_"),
            "A".repeat(84) + "==",
        ]
    ) {
        assertEquals(await check({}, { "Versia-Signature": value }), invalid, value);
    }

    assertEquals(
        await verify(message, headers, () => Promise.resolve(undefined), signedAt),
        invalid,
    );
});

Deno.test("a timestamp with leading zeros is rejected, even when it is what was signed", async () => {
    const padded = "01729243417";
    const digest = await crypto.subtle.digest("SHA-256", message.body);
    const text = `post alice.example /.versia/v0.7/inbox ${padded} ${
        new Uint8Array(digest).toBase64()
    }`;
    const signature = await crypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        new TextEncoder().encode(text),
    );

    assertEquals(
        await check({}, {
            "Versia-Signature": new Uint8Array(signature).toBase64(),
            "Versia-Signed-At": padded,
        }),
        invalid,
    );
});

Deno.test("Versia-Signed-By must be a domain as written in the protocol", async () => {
    let lookedUp = false;
    const lookUp = () => {
        lookedUp = true;
        return Promise.resolve(keys.publicKey);
    };

    for (const signer of ["Bob.example", "bob.example:443", "127.0.0.1", "localhost"]) {
        const received = new Headers(headers);
        received.set("Versia-Signed-By", signer);

        assertEquals(await verify(message, received, lookUp, signedAt), invalid, signer);
    }

    assertEquals(lookedUp, false);
});
