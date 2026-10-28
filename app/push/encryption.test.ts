import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { encryptPush, maxPlaintextBytes, randomSender, type Sender } from "./encryption.ts";

const bytes = (base64url: string) => Uint8Array.fromBase64(base64url, { alphabet: "base64url" });

/**
 * The example's values.
 * @see https://www.rfc-editor.org/rfc/rfc8291#appendix-A
 */
const example = {
    plaintext: bytes("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    serverPublic: bytes(
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    ),
    serverPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    keys: {
        p256dh: bytes(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        ),
        auth: bytes("BTBZMqHH6r4Tts7J_aSIgg"),
    },
    salt: bytes("DGv6ra1nlYgDCS1FRnbzlw"),
    header: bytes(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    ),
    ciphertext: bytes(
        "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
    ),
};

/** The example's sender, whose key pair is its application server's. */
const exampleSender = async (): Promise<Sender> => {
    const jwk = {
        kty: "EC",
        crv: "P-256",
        x: example.serverPublic.slice(1, 33).toBase64({ alphabet: "base64url", omitPadding: true }),
        y: example.serverPublic.slice(33).toBase64({ alphabet: "base64url", omitPadding: true }),
    };
    const curve = { name: "ECDH", namedCurve: "P-256" };

    return {
        keyPair: {
            publicKey: await crypto.subtle.importKey("jwk", jwk, curve, true, []),
            privateKey: await crypto.subtle.importKey(
                "jwk",
                { ...jwk, d: example.serverPrivate },
                curve,
                false,
                ["deriveBits"],
            ),
        },
        salt: example.salt,
    };
};

Deno.test("a push is encrypted as RFC 8291's example is", async () => {
    const body = await encryptPush(example.plaintext, example.keys, await exampleSender());

    assertEquals(body, new Uint8Array([...example.header, ...example.ciphertext]));
});

Deno.test("each push is encrypted with a key and salt of its own, which its header says", async () => {
    const senders = [await randomSender(), await randomSender()];
    const bodies = [];
    for (const sender of senders) {
        bodies.push(await encryptPush(example.plaintext, example.keys, sender));
    }

    for (const [index, sender] of senders.entries()) {
        const own = new Uint8Array(await crypto.subtle.exportKey("raw", sender.keyPair.publicKey));
        assertEquals(bodies[index].slice(0, 16), sender.salt);
        assertEquals(bodies[index].slice(16, 21), new Uint8Array([0, 0, 16, 0, 65]));
        assertEquals(bodies[index].slice(21, 86), own);
    }
    assertNotEquals(senders[0].salt, senders[1].salt);
    assertNotEquals(bodies[0].slice(21, 86), bodies[1].slice(21, 86));
});

Deno.test("a push is at most what push services must take", async () => {
    const sender = await randomSender();

    const most = await encryptPush(new Uint8Array(maxPlaintextBytes), example.keys, sender);
    assertEquals(most.length, 4096);
    await assertRejects(
        () => encryptPush(new Uint8Array(maxPlaintextBytes + 1), example.keys, sender),
        Error,
        "Too much to push",
    );
});
