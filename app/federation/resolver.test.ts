import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { userType } from "../accounts/federation.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { createRegistry } from "./registry.ts";
import { BadReply } from "./request.ts";
import { createResolver, fetchBudget, ResolveFailed } from "./resolver.ts";

const day = 24 * 60 * 60_000;

/** a.test resolving, and bob on b.test. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const bob = await createLocalAccount(network.instances["b.test"].ctx, "bob");
    const resolve = createResolver(registry);

    /** How many entities a.test has fetched from `host`. */
    const fetched = (host: string) =>
        network.transport.sent.filter((request) => {
            const url = new URL(request.url);
            return url.host === host && url.pathname.startsWith("/.versia/v0.6/entities/");
        }).length;

    const user = (host: string, id: string, budget?: { fetches: number }) =>
        resolve(a, { host, id }, "User", budget);

    return { network, a, bob, resolve, fetched, user };
};

const evilUser = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-10-18T12:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

Deno.test("a remote user is fetched once, and again when it is a day old", async () => {
    const { network, a, bob, fetched, user } = await open();
    await using _ = network;

    const id = await user("b.test", bob);
    assertNotEquals(id, undefined);
    const row = await a.db.selectFrom("accounts").select(["username", "remote_id"])
        .where("id", "=", id ?? "").executeTakeFirst();
    assertEquals(row, { username: "bob", remote_id: bob });

    assertEquals(await user("b.test", bob), id);
    assertEquals(fetched("b.test"), 1);

    network.clock.advance(day);
    assertEquals(await user("b.test", bob), id);
    assertEquals(fetched("b.test"), 2);
});

Deno.test("a local user is looked up, not fetched", async () => {
    const { network, a, fetched, user } = await open();
    await using _ = network;
    const alice = await createLocalAccount(a, "alice");

    assertEquals(await user("a.test", alice), alice);
    assertEquals(await user("a.test", "nobody"), undefined);
    assertEquals(fetched("a.test"), 0);
});

Deno.test("a user that is gone counts as missing for an hour", async () => {
    const { network, fetched, user } = await open();
    await using _ = network;

    assertEquals(await user("b.test", "nobody"), undefined);
    assertEquals(await user("b.test", "nobody"), undefined);
    assertEquals(fetched("b.test"), 1);

    network.clock.advance(60 * 60_000);
    assertEquals(await user("b.test", "nobody"), undefined);
    assertEquals(fetched("b.test"), 2);
});

Deno.test("resolves arriving together fetch once", async () => {
    const { network, bob, fetched, user } = await open();
    await using _ = network;

    const [first, second] = await Promise.all([user("b.test", bob), user("b.test", bob)]);

    assertEquals(first, second);
    assertEquals(fetched("b.test"), 1);
});

Deno.test("a blocked instance isn't asked, nor one once the budget is spent", async () => {
    const { network, a, bob, fetched, user } = await open();
    await using _ = network;

    assertEquals(await user("b.test", bob, fetchBudget(0)), undefined);

    const budget = fetchBudget(1);
    assertNotEquals(await user("b.test", bob, budget), undefined);
    assertEquals(budget.fetches, 0);

    await blockDomain(a, "b.test");
    network.clock.advance(day);
    assertEquals(await user("b.test", bob), undefined);
    assertEquals(fetched("b.test"), 1);
});

Deno.test("an instance at an address that isn't a domain isn't asked", async () => {
    const { network, bob, user } = await open();
    await using _ = network;
    const before = network.transport.sent.length;

    // A port or an address could reach a host that blocks, which go by domain, don't cover.
    for (const host of ["b.test:8443", "192.0.2.1", "[2001:db8::1]"]) {
        assertEquals(await user(host, bob), undefined, host);
    }
    assertEquals(network.transport.sent.length, before);
});

Deno.test("when fetching fails, the copy Verso has is used, or else it throws", async () => {
    const { network, bob, user } = await open();
    await using _ = network;
    const id = await user("b.test", bob);

    network.transport.down.add("b.test");
    network.clock.advance(day);
    assertEquals(await user("b.test", bob), id);

    await assertRejects(() => user("b.test", "other"));
    // Not having it is no reason to give up on it.
    network.transport.down.delete("b.test");
    assertEquals(await user("b.test", "other"), undefined);
});

Deno.test("an instance can't answer with another entity, or unsigned", async () => {
    const { network, a, user } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");
    const path = (id: string) => `/.versia/v0.6/entities/User/${id}`;

    evil.serve(path("alice"), evilUser("mallory"));
    evil.serve(path("note"), { ...evilUser("note"), type: "Note" });
    evil.serve(path("bad"), { ...evilUser("bad"), username: "not a name" });
    evil.serve(path("unsigned"), evilUser("unsigned"), { signed: false });

    for (const id of ["alice", "note", "bad"]) {
        await assertRejects(() => user("evil.test", id), ResolveFailed, undefined, id);
    }
    await assertRejects(() => user("evil.test", "unsigned"), BadReply);
    assertEquals(await a.db.selectFrom("accounts").select("username").execute(), []);
});

Deno.test("an instance can't answer with an entity of another type with the same id", async () => {
    const { network, a } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");
    const thing = {
        type: "Thing",
        schema: z.object({ type: z.literal("Thing"), id: z.string() }),
        authority: (_: unknown, origin: string) => origin,
        receive: () => Promise.resolve(),
    };
    const resolve = createResolver(createRegistry([userType, thing]));

    evil.serve("/.versia/v0.6/entities/User/alice", { type: "Thing", id: "alice" });

    await assertRejects(
        () => resolve(a, { host: "evil.test", id: "alice" }, "User"),
        ResolveFailed,
    );
});

Deno.test("an instance can't send an entity only another instance may", async () => {
    const { network, a } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");
    const received: unknown[] = [];
    const elsewhere = {
        type: "Elsewhere",
        schema: z.object({ type: z.literal("Elsewhere"), id: z.string() }),
        authority: () => "other.test",
        receive: (_: unknown, entity: unknown) => Promise.resolve(void received.push(entity)),
        known: () => Promise.resolve(undefined),
    };
    const resolve = createResolver(createRegistry([elsewhere]));

    evil.serve("/.versia/v0.6/entities/Elsewhere/1", { type: "Elsewhere", id: "1" });

    await assertRejects(
        () => resolve(a, { host: "evil.test", id: "1" }, "Elsewhere"),
        ResolveFailed,
        "evil.test may not send",
    );
    assertEquals(received, []);
});
