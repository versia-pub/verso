import { assertEquals } from "@std/assert";
import { importPublicKey, sign, verify } from "@versia/protocol";
import { z } from "zod";
import { instanceKey } from "../instances/keys.ts";
import { remoteKeys } from "../instances/remote_keys.ts";
import { type KeyPair, keyPair, metadataServer } from "../instances/testing.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createApp } from "./app.ts";
import { defineRoute } from "./route.ts";

const routes = [
    defineRoute({
        method: "GET",
        path: "/public",
        summary: "Anyone's",
        responses: { 200: z.object({}) },
        handler: () => Promise.resolve({ status: 200, body: {} }),
    }),
    defineRoute({
        method: "GET",
        path: "/federated",
        summary: "Who signed",
        signed: true,
        responses: { 200: z.object({ signed_by: z.string().optional() }) },
        handler: (_, { signedBy }) =>
            Promise.resolve({ status: 200, body: { signed_by: signedBy } }),
    }),
    defineRoute({
        method: "POST",
        path: "/inbox",
        summary: "What was signed and sent",
        signed: true,
        body: z.object({ text: z.string() }),
        responses: { 200: z.object({ text: z.string() }) },
        handler: (_, { body }) => Promise.resolve({ status: 200, body }),
    }),
];

const open = async () => {
    const transport = fakeTransport();
    const test = await createTestContext({ transport });
    const pair = await keyPair();
    transport.servers.set("b.example", metadataServer("b.example", pair));
    const app = createApp(test.ctx, routes, {
        checkResponses: true,
        remoteKeys: remoteKeys({ refetchAfterMs: 1000 }),
    });

    /** Sends a request signed as `signedBy` with `key`, over `signed` unless the request differs. */
    const send = async (
        request: { method?: string; path?: string; body?: string; signedBy?: string },
        signed: { method?: string; path?: string; body?: string; at?: Date; key?: KeyPair } = {},
    ) => {
        const method = request.method ?? "GET";
        const path = request.path ?? "/federated";
        const headers = await sign(
            {
                method: signed.method ?? method,
                pathname: signed.path ?? path,
                body: new TextEncoder().encode(signed.body ?? request.body ?? ""),
            },
            (signed.key ?? pair).privateKey,
            request.signedBy ?? "b.example",
            signed.at ?? test.clock.now(),
        );

        const response = await app.request(path, {
            method,
            body: request.body,
            headers: { ...headers, "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, transport, pair, app, send };
};

const badSignature = { status: 401, body: { error: "The signature is missing or invalid" } };

Deno.test("a request signed by another instance says who signed it", async () => {
    await using test = await open();

    assertEquals(await test.send({}), { status: 200, body: { signed_by: "b.example" } });
    assertEquals(await test.send({ signedBy: "B.EXAMPLE:443" }), {
        status: 200,
        body: { signed_by: "b.example" },
    });
    assertEquals(
        await test.send({ method: "POST", path: "/inbox", body: '{"text":"Hi"}' }),
        { status: 200, body: { text: "Hi" } },
    );
    assertEquals(test.transport.sent.length, 1);
});

Deno.test("a request without a valid signature is refused", async () => {
    await using test = await open();
    const other = await keyPair();

    const unsigned = await test.app.request("/federated");
    assertEquals({ status: unsigned.status, body: await unsigned.json() }, badSignature);
    assertEquals(await test.send({}, { key: other }), badSignature);
    assertEquals(await test.send({}, { path: "/other" }), badSignature);
    assertEquals(await test.send({}, { method: "POST" }), badSignature);
    assertEquals(await test.send({ signedBy: "c.example" }), badSignature);
    // An instance with no key is asked for one once, not again to refresh it.
    assertEquals(
        test.transport.sent.filter((request) => new URL(request.url).host === "c.example").length,
        1,
    );
    assertEquals(
        await test.send({ method: "POST", path: "/inbox", body: '{"text":"Hi"}' }, {
            body: '{"text":"Bye"}',
        }),
        badSignature,
    );
});

Deno.test("a signature more than five minutes off is refused as stale", async () => {
    await using test = await open();
    const at = (seconds: number) => new Date(test.clock.now().getTime() + seconds * 1000);

    assertEquals((await test.send({}, { at: at(-300) })).status, 200);
    assertEquals((await test.send({}, { at: at(300) })).status, 200);
    for (const seconds of [-301, 301]) {
        assertEquals(await test.send({}, { at: at(seconds) }), {
            status: 422,
            body: { error: "The signature is too old, or from the future" },
        });
    }
});

Deno.test("a rotated key is fetched again, at most once in a while", async () => {
    await using test = await open();
    await test.send({});
    const rotated = await keyPair();
    test.transport.servers.set("b.example", metadataServer("b.example", rotated));

    assertEquals(await test.send({}, { key: rotated }), badSignature);
    test.clock.advance(1000);
    assertEquals((await test.send({}, { key: rotated })).status, 200);
    assertEquals(await test.send({}, { key: test.pair }), badSignature);
    assertEquals(test.transport.sent.length, 2);
});

Deno.test("replies to signed requests are signed by this instance, over what was sent", async () => {
    await using test = await open();
    const ours = await importPublicKey((await instanceKey(test.ctx)).publicKey);
    const checked = async (method: string, path: string, body?: string) => {
        const headers = await sign(
            { method, pathname: path, body: new TextEncoder().encode(body ?? "") },
            test.pair.privateKey,
            "b.example",
            test.clock.now(),
        );
        const response = await test.app.request(path, {
            method,
            body,
            headers: { ...headers, "content-type": "application/json" },
        });
        const bytes = new Uint8Array(await response.arrayBuffer());

        return await verify(
            { method, pathname: path, body: bytes },
            response.headers,
            (domain) => Promise.resolve(domain === "social.example" ? ours : undefined),
            test.clock.now(),
        );
    };

    assertEquals(await checked("GET", "/federated"), { ok: true, signedBy: "social.example" });
    assertEquals((await test.app.request("/public")).headers.get("versia-signature"), null);
    assertEquals(await checked("POST", "/inbox", '{"text":"Hi"}'), {
        ok: true,
        signedBy: "social.example",
    });
});
