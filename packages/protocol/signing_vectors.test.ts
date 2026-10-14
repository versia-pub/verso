import { assertEquals } from "@std/assert";
import { importPublicKey, sign, verify } from "./signing.ts";
import vectors from "./vectors/signing.json" with { type: "json" };

const privateKey = await crypto.subtle.importKey(
  "pkcs8",
  Uint8Array.fromBase64(vectors.private_key),
  "Ed25519",
  false,
  ["sign"],
);
const publicKey = await crypto.subtle.importKey(
  "spki",
  Uint8Array.fromBase64(vectors.public_key),
  "Ed25519",
  false,
  ["verify"],
);
const importedKey = await importPublicKey(vectors.public_key);
const keyOf = () => Promise.resolve(importedKey);
const bytes = (text: string) => new TextEncoder().encode(text);
const dateOf = (signedAt: string) => new Date(Number(signedAt) * 1000);

for (const vector of vectors.vectors) {
  const message = {
    method: vector.method,
    pathname: vector.pathname,
    body: bytes(vector.body),
  };
  const now = dateOf(vector.signed_at);

  Deno.test(`vector "${vector.name}": the signature is over the signed string`, async () => {
    // Checks the vector itself, without Verso's code.
    assertEquals(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Uint8Array.fromBase64(vector.signature),
        bytes(vector.signed_string),
      ),
      true,
    );
  });

  Deno.test(`vector "${vector.name}": Verso signs and verifies it`, async () => {
    assertEquals(await sign(message, privateKey, vectors.signed_by, now), {
      "Versia-Signature": vector.signature,
      "Versia-Signed-By": vectors.signed_by,
      "Versia-Signed-At": vector.signed_at,
    });
    const headers = new Headers({
      "Versia-Signature": vector.signature,
      "Versia-Signed-By": vectors.signed_by,
      "Versia-Signed-At": vector.signed_at,
    });
    assertEquals(await verify(message, headers, keyOf, now), {
      ok: true,
      signedBy: vectors.signed_by,
    });
  });
}

Deno.test("the same JSON with different bytes doesn't verify", async () => {
  // Servers must verify the body exactly as received, before parsing it. Re-serialising the
  // parsed JSON can change whitespace, key order or escapes, and with them the signature.
  const [vector] = vectors.vectors;
  const headers = new Headers({
    "Versia-Signature": vector.signature,
    "Versia-Signed-By": vectors.signed_by,
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
    const message = {
      method: vector.method,
      pathname: vector.pathname,
      body: bytes(body),
    };
    assertEquals(
      await verify(message, headers, keyOf, dateOf(vector.signed_at)),
      { ok: false, reason: "invalid" },
      body,
    );
  }
});
