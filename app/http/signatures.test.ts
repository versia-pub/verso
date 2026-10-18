import { assertEquals } from "@std/assert";
import { importPublicKey, sign, verify } from "@versia/protocol";
import { z } from "zod";
import { instanceKey } from "../instances/keys.ts";
import { remoteKeys } from "../instances/remote_keys.ts";
import { type KeyPair, keyPair, metadataServer } from "../instances/testing.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { blockDomain, domainBlocks } from "../moderation/domain_blocks.ts";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import { NotFound } from "./errors.ts";
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
    defineRoute({
        method: "POST",
        path: "/raw",
        summary: "The bytes that were signed",
        signed: true,
        responses: { 200: z.object({ text: z.string() }) },
        handler: (_, { signedBody }) =>
            Promise.resolve({ status: 200, body: { text: new TextDecoder().decode(signedBody) } }),
    }),
    defineRoute({
        method: "GET",
        path: "/missing",
        summary: "Nothing",
        signed: true,
        responses: { 200: z.object({}) },
        handler: () => Promise.reject(new NotFound()),
    }),
];

const open = async (options: { silentBlocks?: boolean } = {}) => {
    const transport = fakeTransport();
    const test = await createTestContext({
        transport,
        federation: {
            remoteKeys: remoteKeys({ refetchAfterMs: 1000 }),
            isBlocked: domainBlocks(["blocked.example"]),
        },
    });
    const pair = await keyPair();
    transport.servers.set("b.example", metadataServer("b.example", pair));
    const app = createTestApp(test.ctx, routes, {
        checkResponses: true,
        silentBlocks: options.silentBlocks,
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
        const text = await response.text();
        return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
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

Deno.test("a signed route can read the body exactly as it was signed", async () => {
    await using test = await open();
    const body = '{ "text" : "Hi",\n  "text": 1e3 }';

    assertEquals(await test.send({ method: "POST", path: "/raw", body }), {
        status: 200,
        body: { text: body },
    });
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

Deno.test("a blocked instance is refused before Verso asks it for its key", async () => {
    await using test = await open();
    const defederated = {
        status: 403,
        body: { error: "This instance doesn't federate with yours" },
    };
    const asked = (domain: string) =>
        test.transport.sent.filter((request) => new URL(request.url).host === domain).length;

    assertEquals(await test.send({ signedBy: "blocked.example" }), defederated);
    assertEquals(await test.send({ signedBy: "a.blocked.example" }), defederated);
    assertEquals(asked("blocked.example") + asked("a.blocked.example"), 0);

    // The headers and the time are checked first.
    const old = new Date(test.clock.now().getTime() - 600_000);
    assertEquals((await test.send({ signedBy: "blocked.example" }, { at: old })).status, 422);

    // A block applies to an instance whose key Verso already has, too.
    assertEquals((await test.send({})).status, 200);
    await blockDomain(test.ctx, "b.example");
    assertEquals(await test.send({}), defederated);
    assertEquals(asked("b.example"), 1);
});

Deno.test("with silent blocks, a blocked instance finds nothing, and what it sends is taken", async () => {
    await using test = await open({ silentBlocks: true });
    const notFound = { status: 404, body: { error: "Record not found" } };

    assertEquals(await test.send({ signedBy: "blocked.example" }), notFound);
    assertEquals(await test.send({ path: "/missing" }), notFound);
    assertEquals(
        await test.send({
            method: "POST",
            path: "/inbox",
            body: '{"text":"Hi"}',
            signedBy: "blocked.example",
        }),
        { status: 202, body: undefined },
    );
    assertEquals(
        test.transport.sent.filter((request) => new URL(request.url).host === "blocked.example")
            .length,
        0,
    );
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

Deno.test("error replies to signed routes are signed too, even when the request isn't", async () => {
    await using test = await open();
    const ours = await importPublicKey((await instanceKey(test.ctx)).publicKey);
    const checked = async (path: string, headers: Record<string, string> = {}) => {
        const response = await test.app.request(path, { headers });
        const bytes = new Uint8Array(await response.arrayBuffer());

        return {
            status: response.status,
            verification: await verify(
                { method: "GET", pathname: path, body: bytes },
                response.headers,
                (domain) => Promise.resolve(domain === "social.example" ? ours : undefined),
                test.clock.now(),
            ),
        };
    };
    const signed = { ok: true, signedBy: "social.example" } as const;

    const headers = await sign(
        { method: "GET", pathname: "/missing", body: new Uint8Array() },
        test.pair.privateKey,
        "b.example",
        test.clock.now(),
    );
    assertEquals(await checked("/missing", headers), { status: 404, verification: signed });
    assertEquals(await checked("/federated"), { status: 401, verification: signed });
});
