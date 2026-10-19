import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { enqueue } from "../jobs/queue.ts";
import { drain } from "../jobs/worker.ts";
import { blockDomain, listBlockedDomains } from "../moderation/domain_blocks.ts";
import { createTestContext } from "../testing/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { inboxQueue, queueEntity } from "./inbox.ts";
import { inboxHandler } from "./inbox_worker.ts";
import { createRegistry, type EntityType, type Sender } from "./registry.ts";

const Thing = z.object({ type: z.literal("Thing"), id: z.string(), author: z.string() });
type Thing = z.infer<typeof Thing>;

/**
 * Things are sent by their author's instance. One with the id `fail` can't be applied, and
 * `partial` fails after a write, which must not be kept.
 */
const things = () => {
    const received: { thing: Thing; sender: Sender }[] = [];
    const thing: EntityType<Thing> = {
        type: "Thing",
        schema: Thing,
        authority: (entity) => entity.author,
        receive: async (ctx, entity, sender) => {
            if (entity.id === "partial") await blockDomain(ctx, "written.example");
            if (entity.id === "fail" || entity.id === "partial") throw new Error("Can't");

            received.push({ thing: entity, sender });
        },
    };

    return { received, registry: createRegistry([thing]) };
};

const open = async () => {
    const test = await createTestContext();
    const { received, registry } = things();
    const instanceId = test.ctx.ids();
    await test.ctx.db.insertInto("instances").values({
        id: instanceId,
        domain: "b.example",
        protocol: "versia",
        public_key: null,
        key_fetched_at: null,
        created_at: test.clock.now(),
    }).execute();

    /** Queues a thing as `signer` sent it, and runs the inbox. Returns its job. */
    const send = async (thing: Partial<Thing>, signer = "b.example") => {
        const body = { type: "Thing", id: "1", author: "b.example", ...thing };
        await queueEntity(
            test.ctx,
            registry,
            signer,
            new TextEncoder().encode(JSON.stringify(body)),
        );
        await drain(test.ctx, {
            [inboxQueue]: { handler: inboxHandler(registry), concurrency: 1 },
        });

        return await test.ctx.db.selectFrom("jobs").selectAll().orderBy("created_at", "desc")
            .executeTakeFirstOrThrow();
    };

    return { ...test, received, registry, instanceId, send };
};

Deno.test("an entity is applied with who sent it, and its job is done", async () => {
    await using test = await open();

    const job = await test.send({});

    assertEquals(test.received, [{
        thing: { type: "Thing", id: "1", author: "b.example" },
        sender: { domain: "b.example", instanceId: test.instanceId, fetched: false },
    }]);
    assertEquals(job.finished_at, test.clock.now());
});

Deno.test("an entity from an instance that may not send it is given up on", async () => {
    await using test = await open();

    const job = await test.send({ author: "c.example" });

    assertEquals(test.received, []);
    assertEquals(job.attempts, job.max_attempts);
    assertStringIncludes(job.last_error ?? "", "b.example may not send this Thing");
});

Deno.test("an entity that fails to apply is retried, with none of its writes kept", async () => {
    await using test = await open();

    for (const id of ["fail", "partial"]) {
        const job = await test.send({ id });

        assertEquals(job.attempts, 1);
        assertEquals(job.finished_at, null);
        assertStringIncludes(job.last_error ?? "", "Can't");
    }
    assertEquals(await listBlockedDomains(test.ctx), []);
});

Deno.test("a job whose entity no longer checks out is given up on", async () => {
    await using test = await open();
    const registry = things().registry;
    const payloads = [
        { signer: "b.example", body: '{"type": "Thing"}' },
        { signer: "b.example", body: "{" },
        { body: "{}" },
    ];

    for (const payload of payloads) await enqueue(test.ctx, { queue: inboxQueue, payload });
    await drain(test.ctx, { [inboxQueue]: { handler: inboxHandler(registry), concurrency: 1 } });

    const jobs = await test.ctx.db.selectFrom("jobs").selectAll().execute();
    assertEquals(jobs.map((job) => job.attempts === job.max_attempts), [true, true, true]);
});

Deno.test("an entity from an instance blocked since it was queued is dropped", async () => {
    await using test = await open();
    const body = new TextEncoder().encode('{"type": "Thing", "id": "1", "author": "b.example"}');

    await queueEntity(test.ctx, test.registry, "b.example", body);
    await blockDomain(test.ctx, "b.example");
    await drain(test.ctx, {
        [inboxQueue]: { handler: inboxHandler(test.registry), concurrency: 1 },
    });

    const job = await test.ctx.db.selectFrom("jobs").selectAll().executeTakeFirstOrThrow();
    assertEquals(test.received, []);
    assertEquals([job.finished_at, job.attempts], [test.clock.now(), 1]);
});

Deno.test("an entity from an instance Verso has no row for is retried", async () => {
    await using test = await open();

    const job = await test.send({ author: "c.example" }, "c.example");

    assertEquals(test.received, []);
    assertEquals(job.attempts, 1);
    assertStringIncludes(job.last_error ?? "", "c.example isn't a known instance");
});

Deno.test("a User sent unasked updates one Verso has, and is dropped otherwise", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");
    const user = {
        type: "User",
        id: "alice",
        created_at: "2026-10-18T12:00:00Z",
        username: "alice",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    };
    const account = () =>
        a.db.selectFrom("accounts").innerJoin("instances", "instances.id", "accounts.instance_id")
            .select(["username", "display_name", "remote_id", "domain"]).execute();

    await evil.send("https://a.test/.versia/v0.6/inbox", { body: user });
    await network.drain();
    assertEquals(await account(), []);

    evil.serve("/.versia/v0.6/entities/User/alice", user);
    await a.federation.resolve(a, { host: "evil.test", id: "alice" }, "User");
    assertEquals(await account(), [{
        username: "alice",
        display_name: "",
        remote_id: "alice",
        domain: "evil.test",
    }]);

    await evil.send("https://a.test/.versia/v0.6/inbox", {
        body: { ...user, display_name: "Alice" },
    });
    await network.drain();
    assertEquals((await account()).map((row) => row.display_name), ["Alice"]);
});
