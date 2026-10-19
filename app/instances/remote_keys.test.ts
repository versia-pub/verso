import { assert, assertEquals, assertFalse } from "@std/assert";
import { fakeTransport, type Server } from "../kernel/fake_transport.ts";
import { createTestContext } from "../testing/context.ts";
import { remoteKeys } from "./remote_keys.ts";
import { type KeyPair, keyPair, metadata, metadataServer } from "./testing.ts";

/** Whether `key` is the public half of `pair`. */
const isKeyOf = async (key: CryptoKey | undefined, pair: KeyPair) => {
    const data = new TextEncoder().encode("hello");
    const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, data);
    return key !== undefined && await crypto.subtle.verify("Ed25519", key, signature, data);
};

const open = async () => {
    const transport = fakeTransport();
    const test = await createTestContext({ transport });

    const row = (domain: string) =>
        test.ctx.db.selectFrom("instances")
            .select(["domain", "protocol", "public_key", "key_fetched_at"])
            .where("domain", "=", domain)
            .executeTakeFirst();

    return { ...test, transport, row };
};

Deno.test("a key is fetched from the instance's metadata once, then stored", async () => {
    await using test = await open();
    const pair = await keyPair();
    test.transport.servers.set("b.example", metadataServer("b.example", pair));
    const keys = remoteKeys();

    const [first, together] = await Promise.all([
        keys.get(test.ctx, "b.example"),
        keys.get(test.ctx, "b.example"),
    ]);
    const again = await keys.get(test.ctx, "b.example");
    test.transport.servers.delete("b.example");
    const fromDatabase = await remoteKeys().get(test.ctx, "b.example");

    for (const key of [first, together, again, fromDatabase]) assert(await isKeyOf(key, pair));
    assertEquals(
        test.transport.sent.map((request) => [
            request.url,
            request.headers.get("accept"),
            request.headers.get("user-agent"),
        ]),
        [[
            "https://b.example/.versia/v0.6/instance",
            "application/vnd.versia+json; charset=utf-8",
            "Verso/0.0.0 (+https://social.example)",
        ]],
    );
    assertEquals(await test.row("b.example"), {
        domain: "b.example",
        protocol: "versia",
        public_key: pair.spki,
        key_fetched_at: test.clock.now(),
    });
});

Deno.test("a key isn't taken from metadata that is wrong, or from an unreachable instance", async () => {
    await using test = await open();
    const pair = await keyPair();
    const servers: Record<string, Server> = {
        "other.example": metadataServer("b.example", pair),
        "missing.example": () =>
            Response.json(metadata("missing.example", pair.spki), { status: 404 }),
        "broken.example": () => new Response("{"),
        "rsa.example": () => Response.json(metadata("rsa.example", pair.spki, "rsa")),
        "badkey.example": metadataServer("badkey.example", { spki: "AAAA" }),
        // Valid metadata, but padded past what Verso reads.
        "big.example": () =>
            new Response(
                JSON.stringify(metadata("big.example", pair.spki)) + " ".repeat(1024 * 1024),
            ),
    };
    for (const [domain, server] of Object.entries(servers)) {
        test.transport.servers.set(domain, server);
    }

    for (const domain of [...Object.keys(servers), "down.example"]) {
        assertEquals(await remoteKeys().get(test.ctx, domain), undefined, domain);
        assertEquals(await test.row(domain), undefined, domain);
    }
});

Deno.test("a key is fetched again to refresh it only once it is old enough", async () => {
    await using test = await open();
    const [before, after] = [await keyPair(), await keyPair()];
    test.transport.servers.set("b.example", metadataServer("b.example", before));
    const keys = remoteKeys({ refetchAfterMs: 1000 });
    await keys.get(test.ctx, "b.example");

    test.transport.servers.set("b.example", metadataServer("b.example", after));
    test.clock.advance(999);
    assert(await isKeyOf(await keys.refresh(test.ctx, "b.example"), before));
    assert(await isKeyOf(await keys.get(test.ctx, "b.example"), before));

    test.clock.advance(1);
    assert(await isKeyOf(await keys.refresh(test.ctx, "b.example"), after));
    assert(await isKeyOf(await keys.get(test.ctx, "b.example"), after));
    assertEquals((await test.row("b.example"))?.public_key, after.spki);
    assertEquals(test.transport.sent.length, 2);
});

Deno.test("a refresh takes a key another node stored, and fetches one never stored", async () => {
    await using test = await open();
    const [before, after] = [await keyPair(), await keyPair()];
    test.transport.servers.set("b.example", metadataServer("b.example", before));
    const keys = remoteKeys();
    await keys.get(test.ctx, "b.example");
    await test.ctx.db.updateTable("instances").set({ public_key: after.spki }).execute();

    assert(await isKeyOf(await keys.refresh(test.ctx, "b.example"), after));
    assert(await isKeyOf(await keys.get(test.ctx, "b.example"), after));

    test.transport.servers.set("c.example", metadataServer("c.example", before));
    assert(await isKeyOf(await keys.refresh(test.ctx, "c.example"), before));
    assertEquals(test.transport.sent.length, 2);
});

Deno.test("only the most recently used keys are kept in memory", async () => {
    await using test = await open();
    const pair = await keyPair();
    for (const domain of ["a.example", "b.example", "c.example"]) {
        test.transport.servers.set(domain, metadataServer(domain, pair));
    }
    const keys = remoteKeys({ capacity: 2 });

    await keys.get(test.ctx, "a.example");
    await keys.get(test.ctx, "b.example");
    await keys.get(test.ctx, "a.example");
    await keys.get(test.ctx, "c.example");
    // Without the stored rows or the servers, only what is in memory is left.
    await test.ctx.db.deleteFrom("instances").execute();
    test.transport.servers.clear();

    assert(await isKeyOf(await keys.get(test.ctx, "a.example"), pair));
    assert(await isKeyOf(await keys.get(test.ctx, "c.example"), pair));
    assertFalse(await isKeyOf(await keys.get(test.ctx, "b.example"), pair));
});
