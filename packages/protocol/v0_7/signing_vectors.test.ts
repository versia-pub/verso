import { assertEquals, assertExists } from "@std/assert";
import { importPublicKey, sign, verify } from "./signing.ts";
import vectors from "./vectors/signing.json" with { type: "json" };

const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.fromBase64(vectors.private_key),
    "Ed25519",
    false,
    ["sign"],
);
const publicKey = await importPublicKey(vectors.public_key);
const keyOf = () => Promise.resolve(publicKey);

const bytes = (text: string) => new TextEncoder().encode(text);
const dateOf = (signedAt: string) => new Date(Number(signedAt) * 1000);

for (const vector of vectors.vectors) {
    const message = {
        method: vector.method,
        host: vector.host,
        target: vector.target,
        body: bytes(vector.body),
    };
    const now = dateOf(vector.signed_at);

    Deno.test(`vector "${vector.name}": the signature is over the signed string`, async () => {
        // Checks the vector itself, without Verso's code.
        assertEquals(
            publicKey !== undefined && await crypto.subtle.verify(
                "Ed25519",
                publicKey,
                Uint8Array.fromBase64(vector.signature),
                bytes(vector.signed_string),
            ),
            true,
        );
    });

    Deno.test(`vector "${vector.name}": Verso signs and verifies it`, async () => {
        const headers = {
            "Versia-Signature": vector.signature,
            "Versia-Signed-By": vector.signed_by,
            "Versia-Signed-At": vector.signed_at,
        };

        assertEquals(await sign(message, privateKey, vector.signed_by, now), headers);
        assertEquals(await verify(message, new Headers(headers), keyOf, now), {
            ok: true,
            signedBy: vector.signed_by,
        });
    });
}

Deno.test("the first vector is the spec's worked example", () => {
    const [vector] = vectors.vectors;

    assertEquals(
        vector.signed_string,
        "post alice.example /.versia/v0.7/inbox 1729243417 4+e2vswDyKEalby/akgnvZl4yJTXIbN1u42bC6inlOo=",
    );
});

Deno.test("the same JSON with different bytes doesn't verify", async () => {
    // Servers must verify the body exactly as received, before parsing it. Re-serialising the
    // parsed JSON can change whitespace, key order or escapes, and with them the signature.
    const [vector] = vectors.vectors;
    const headers = new Headers({
        "Versia-Signature": vector.signature,
        "Versia-Signed-By": vector.signed_by,
        "Versia-Signed-At": vector.signed_at,
    });

    for (
        const body of [
            '{ "content": "Hello, world!" }',
            '{"content":"Hello, world!"}\n',
            '{"content":"Hello, world\\u0021"}',
        ]
    ) {
        assertEquals(JSON.parse(body), JSON.parse(vector.body));

        const message = { ...vector, body: bytes(body) };
        assertEquals(
            await verify(message, headers, keyOf, dateOf(vector.signed_at)),
            { ok: false },
            body,
        );
    }
});

Deno.test("a query re-encoded by a URL parser doesn't verify", async () => {
    const vector = vectors.vectors.find((vector) => vector.target.includes("%31"));
    assertExists(vector);

    const headers = new Headers({
        "Versia-Signature": vector.signature,
        "Versia-Signed-By": vector.signed_by,
        "Versia-Signed-At": vector.signed_at,
    });
    const message = {
        ...vector,
        target: vector.target.replace("%31", "1"),
        body: bytes(vector.body),
    };

    assertEquals(await verify(message, headers, keyOf, dateOf(vector.signed_at)), { ok: false });
});
