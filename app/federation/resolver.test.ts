import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { userType } from "../accounts/federation.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import type { Reference } from "@versia/protocol";
import type { Budget, Context, Resolver } from "../kernel/context.ts";
import { createRegistry, type Sender } from "./registry.ts";
import { BadReply, fetchUnsigned, Unreachable } from "./request.ts";
import {
    createResolver,
    fetchBudget,
    ResolveFailed,
    type ResolverOptions,
    withDeadline,
} from "./resolver.ts";

const day = 24 * 60 * 60_000;

/** a.test resolving, and bob on b.test. */
const open = async (options: ResolverOptions = {}) => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const bob = await createLocalAccount(network.instances["b.test"].ctx, "bob");
    const resolve = createResolver(registry, options);

    /** How many entities a.test has fetched from `host`. */
    const fetched = (host: string) =>
        network.transport.sent.filter((request) => {
            const url = new URL(request.url);
            return url.host === host && url.pathname.startsWith("/.versia/v0.6/entities/");
        }).length;

    const user = (host: string, id: string, budget?: Budget) =>
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

Deno.test("a fetched entity is prepared before its transaction, from the same budget", async () => {
    const { network, a } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");
    const prepared: unknown[] = [];
    const received: unknown[] = [];
    const thing = {
        type: "Thing",
        schema: z.object({ type: z.literal("Thing"), id: z.string() }),
        authority: (_: unknown, origin: string) => origin,
        prepare: (ctx: Context, _: unknown, sender: Sender, budget: Budget) => {
            prepared.push([ctx.db.isTransaction, sender.fetched, received.length, budget.fetches]);
            return Promise.resolve();
        },
        receive: (_: unknown, entity: unknown) => Promise.resolve(void received.push(entity)),
        known: () => Promise.resolve({ id: "1", fetchedAt: null }),
    };
    const resolve = createResolver(createRegistry([thing]));

    evil.serve("/.versia/v0.6/entities/Thing/1", { type: "Thing", id: "1" });

    assertEquals(await resolve(a, { host: "evil.test", id: "1" }, "Thing", fetchBudget(5)), "1");
    assertEquals(prepared, [[false, true, 0, 4]]);
    assertEquals(received.length, 1);
});

Deno.test("entities that refer to each other are fetched once each, without waiting", async () => {
    const { network, a } = await open();
    await using _ = network;
    const evil = await addEvilInstance(network, "evil.test");
    const saved = new Set<string>();
    const Linked = z.object({ type: z.literal("Linked"), id: z.string(), next: z.string() });
    const linked = {
        type: "Linked",
        schema: Linked,
        authority: (_: unknown, origin: string) => origin,
        prepare: async (ctx: Context, entity: z.infer<typeof Linked>, _: Sender, budget: Budget) =>
            void await resolve(ctx, { host: "evil.test", id: entity.next }, "Linked", budget),
        receive: (_: unknown, entity: z.infer<typeof Linked>) =>
            Promise.resolve(void saved.add(entity.id)),
        known: (_: unknown, reference: Reference) =>
            Promise.resolve(
                saved.has(reference.id) ? { id: reference.id, fetchedAt: null } : undefined,
            ),
    };
    // Read only once the type is created, when the first entity is prepared.
    const resolve: Resolver = createResolver(createRegistry([linked]));

    evil.serve("/.versia/v0.6/entities/Linked/1", { type: "Linked", id: "1", next: "2" });
    evil.serve("/.versia/v0.6/entities/Linked/2", { type: "Linked", id: "2", next: "1" });
    evil.serve("/.versia/v0.6/entities/Linked/3", { type: "Linked", id: "3", next: "3" });

    assertEquals(await resolve(a, { host: "evil.test", id: "1" }, "Linked"), "1");
    assertEquals(await resolve(a, { host: "evil.test", id: "3" }, "Linked"), "3");
    assertEquals([...saved], ["2", "1", "3"]);
});

Deno.test("a budget past its deadline fetches nothing", async () => {
    const { network, a, bob, fetched, user } = await open();
    await using _ = network;

    assertEquals(await user("b.test", bob, fetchBudget(5, a.clock.now().getTime())), undefined);
    assertEquals(fetched("b.test"), 0);

    assertNotEquals(
        await user("b.test", bob, fetchBudget(5, a.clock.now().getTime() + 1)),
        undefined,
    );
    assertEquals(fetched("b.test"), 1);
});

Deno.test("each instance is sent only so many fetches in a window", async () => {
    const { network, fetched, user } = await open({ fetchLimit: { limit: 2, windowMs: 1000 } });
    await using _ = network;
    const b = network.instances["b.test"].ctx;
    const ids = [];
    for (const name of ["bob2", "bob3", "bob4"]) ids.push(await createLocalAccount(b, name));

    assertNotEquals(await user("b.test", ids[0]), undefined);
    assertNotEquals(await user("b.test", ids[1]), undefined);
    assertEquals(await user("b.test", ids[2]), undefined);
    assertEquals(fetched("b.test"), 2);

    network.clock.advance(1000);
    assertNotEquals(await user("b.test", ids[2]), undefined);
});

Deno.test("an instance that can't be reached now isn't fetched from", async () => {
    const { network, a, bob, fetched, user } = await open();
    await using _ = network;
    const id = await user("b.test", bob);
    network.clock.advance(day);
    await a.db.updateTable("instances")
        .set({ parked_until: new Date(a.clock.now().getTime() + 60_000) })
        .where("domain", "=", "b.test").execute();

    // What Verso has is used in the meantime.
    assertEquals(await user("b.test", bob), id);
    assertEquals(fetched("b.test"), 1);
    await assertRejects(() => user("b.test", "nobody"), ResolveFailed);

    // Once its wait is over, it is requested again.
    network.clock.advance(60_000);
    assertEquals(await user("b.test", bob), id);
    assertEquals(fetched("b.test"), 2);
});

Deno.test("a resolve stops fetching when its budget's deadline passes", async () => {
    const { network, a, user } = await open();
    await using _ = network;
    network.transport.servers.set("slow.test", (request) =>
        new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }));

    const started = performance.now();
    await assertRejects(() => user("slow.test", "x", fetchBudget(1, a.clock.now().getTime() + 50)));

    assertEquals(performance.now() - started < 5000, true);
});

Deno.test("a fetch under way stops when its budget's deadline passes", async () => {
    const { network, a } = await open();
    await using _ = network;
    network.transport.servers.set("slow.test", (request) =>
        new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }));
    const budget = fetchBudget(1, a.clock.now().getTime() + 50);

    const started = performance.now();
    await assertRejects(
        () => fetchUnsigned(withDeadline(a, budget), new URL("https://slow.test/"), "*/*"),
        Unreachable,
    );

    assertEquals(performance.now() - started < 5000, true);
    assertEquals(withDeadline(a, fetchBudget()), a);
});
