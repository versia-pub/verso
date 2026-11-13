import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { CompiledQuery, type KyselyPlugin, sql } from "kysely";
import { updateProfile } from "../accounts/profile.ts";
import { deleteAccount } from "../accounts/account_queries.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { recordReached, recordUnreachable } from "../instances/reachability.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context, DomainEvent, Subscriber } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { testDatabaseKind } from "../db/testing.ts";
import { hearJobWakeups } from "../jobs/wakeups.ts";
import type { Settings } from "../kernel/settings.ts";
import { createTestContext } from "../testing/context.ts";
import { addFollowers } from "../graph/testing.ts";
import { batchesOf } from "../db/batches.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import {
    deleteExpiredDeliveryBodies,
    deliverQueue,
    expiredDeliveryBodies,
    fanOutDeadPayload,
    fanOutHandler,
    fanOutQueue,
    queueDeliveries,
    queueDeliveriesTo,
} from "./deliver.ts";
import { deleteEntity } from "./delete.ts";
import { fanOut, queuedDeliveries } from "./testing.ts";

/** An event only these tests emit: an account, to deliver to some recipients. */
type Tested = DomainEvent & { readonly accountId: string; readonly recipients: string[] };

const isTested = (event: DomainEvent): event is Tested => event.type === "Tested";

/** Delivers the account in each `Tested` event as a User, as a protocol's subscriber would. */
const deliverTested: Subscriber = async (ctx, event) => {
    if (!isTested(event)) return;

    const user = await registry.types.get("User")?.find?.(ctx, event.accountId, "");
    assertExists(user);

    await queueDeliveries(ctx, user, event.recipients);
};

/**
 * alice is local, two users are on b.example, one on c.example, and one on the blocked d.example.
 */
const open = async (settings: Partial<Settings> = {}) => {
    const test = await createTestContext({ subscribers: [deliverTested], settings });
    const alice = await createLocalAccount(test.ctx, "alice");

    const remote = async (id: string, instance: string) => {
        await test.ctx.db.insertInto("accounts")
            .values({
                id,
                username: id,
                instance_id: instance,
                remote_id: id,
                created_at: test.clock.now(),
            })
            .execute();
    };
    for (const domain of ["b.example", "c.example", "d.example"]) {
        await createInstance(test.ctx, domain);
    }
    await remote("b1", "b.example");
    await remote("b2", "b.example");
    await remote("c1", "c.example");
    await remote("d1", "d.example");
    await blockDomain(test.ctx, "d.example");

    const send = (recipients: string[], ctx: Context = test.ctx) => {
        const event: Tested = { type: "Tested", accountId: alice, recipients };
        return ctx.transaction((tx) => emit(tx, event));
    };

    /** The queued deliveries, by domain. */
    const queued = async () =>
        (await queuedDeliveries(test.ctx)).sort((a, b) => a.domain.localeCompare(b.domain));

    /** The stored entities, oldest first. */
    const bodies = async () =>
        (await test.ctx.db.selectFrom("delivery_bodies").select("id").orderBy("id").execute())
            .map((row) => row.id);

    return { ...test, alice, send, queued, bodies };
};

Deno.test("an entity is queued once for each instance its recipients are on", async () => {
    await using test = await open();

    await test.send(["b1", "c1", "b2", "d1", test.alice, "missing"]);

    const jobs = await test.queued();
    assertEquals(jobs.map((job) => job.domain), ["b.example", "c.example"]);
    assertEquals(JSON.parse(jobs[0].body).username, "alice");

    // The entity is stored once, and each job refers to it.
    const [bodyId] = await test.bodies();
    const payloads = await test.ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", deliverQueue).execute();
    assertEquals(payloads.map((job) => Object.keys(job.payload).sort()), [
        ["bodyId", "domain"],
        ["bodyId", "domain"],
    ]);
    assertEquals(payloads.map((job) => job.payload.bodyId), [bodyId, bodyId]);

    // Grouped by instance, and given up on by age, not by number of attempts.
    const rows = await test.ctx.db.selectFrom("jobs").select(["group_key", "max_attempts"])
        .orderBy("group_key").execute();
    assertEquals(rows, [
        { group_key: "b.example", max_attempts: 1000 },
        { group_key: "c.example", max_attempts: 1000 },
    ]);
});

Deno.test({
    name: "deliveries don't wake idle workers, which find them by polling, but their fan-out does",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        await using wakeups = hearJobWakeups(test.ctx);
        let woken = false;
        let fannedOut = false;
        wakeups.addEventListener(deliverQueue, () => woken = true);
        wakeups.addEventListener(fanOutQueue, () => fannedOut = true);

        await test.send(["b1", "c1"]);

        // The one job that queues them does, so they are queued at once.
        assertEquals(fannedOut, true);
        assertEquals((await test.queued()).length, 2);
        assertEquals(woken, false);
    },
});

Deno.test("an instance unreached for as long as settings say is sent nothing, until it answers", async () => {
    await using test = await open();
    await recordUnreachable(test.ctx, "b.example");
    test.clock.advance(7 * 24 * 60 * 60_000 - 1);
    await recordUnreachable(test.ctx, "b.example");

    await test.send(["b1", "c1"]);
    assertEquals((await test.queued()).map((job) => job.domain), ["b.example", "c.example"]);

    test.clock.advance(1);
    await test.send(["b1", "c1"]);
    assertEquals((await test.queued()).map((job) => job.domain), [
        "b.example",
        "c.example",
        "c.example",
    ]);

    await recordReached(test.ctx, "b.example");
    await test.send(["b1"]);
    assertEquals((await test.queued()).filter((job) => job.domain === "b.example").length, 2);
});

Deno.test("nothing is queued without remote recipients", async () => {
    await using test = await open();

    await test.send([]);
    await test.send([test.alice, "d1"]);

    assertEquals(await test.queued(), []);
    assertEquals(await test.bodies(), []);
});

Deno.test("what is sent is the entity as it was when queued", async () => {
    await using test = await open();

    await test.send(["b1"]);
    await updateProfile(test.ctx, test.alice, { displayName: "Alice" });

    const [job] = await test.queued();
    assertEquals(JSON.parse(job.body).display_name, undefined);
});

Deno.test("a change that fails queues nothing", async () => {
    await using test = await open();

    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await test.send(["b1"], tx);
            throw new Error("Can't");
        })
    );

    assertEquals(await test.queued(), []);
    assertEquals(await test.bodies(), []);
});

Deno.test("entities are deleted once their deliveries are given up on, a batch at a time", async () => {
    await using test = await open();
    const hour = 60 * 60_000;

    for (let n = 0; n < 5; n++) await test.send(["b1"]);
    test.clock.advance(hour);
    await test.send(["b1"]);
    const [kept] = (await test.bodies()).slice(-1);

    test.clock.advance(47 * hour);
    let deletes = 0;
    const counting: KyselyPlugin = {
        transformQuery: ({ node }) => {
            if (node.kind === "DeleteQueryNode") deletes++;

            return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
    };
    await deleteExpiredDeliveryBodies({ ...test.ctx, db: test.ctx.db.withPlugin(counting) }, 2);

    assertEquals(await test.bodies(), [kept]);
    // Two, two, then the last one.
    assertEquals(deletes, 3);
});

Deno.test("entities are deleted as long after they were queued as settings say", async () => {
    await using test = await open({ deliveryMs: 60_000 });

    await test.send(["b1"]);
    test.clock.advance(59_999);
    await deleteExpiredDeliveryBodies(test.ctx);
    assertEquals((await test.bodies()).length, 1);

    test.clock.advance(1);
    await deleteExpiredDeliveryBodies(test.ctx);
    assertEquals(await test.bodies(), []);
});

Deno.test("old entities are found by when they were queued", async () => {
    await using test = await open();
    const { db } = test.ctx;

    const old = expiredDeliveryBodies(test.ctx, test.clock.now()).limit(1000).compile();
    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${old.sql}`, [...old.parameters]),
        );
        assertStringIncludes(
            plan.rows.map((row) => row.detail).join("\n"),
            "delivery_bodies_created_at (created_at<?)",
        );
        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (format json) ${old.sql}`, [...old.parameters]),
    );
    assertStringIncludes(JSON.stringify(plan.rows), '"Index Name":"delivery_bodies_created_at"');
});

/** The fan-out jobs queued, oldest first. */
const fanOutJobs = async (ctx: Context): Promise<JobsTable[]> =>
    await ctx.db.selectFrom("jobs").selectAll().where("queue", "=", fanOutQueue).orderBy("id")
        .execute();

Deno.test("sending to followers queues one job, without reading who they are", async () => {
    await using test = await open();
    await addFollowers(test.ctx, test.alice, 30, ["b.example", "c.example", null]);
    const tables: string[] = [];
    const recording: KyselyPlugin = {
        transformQuery: ({ node }) => {
            tables.push(JSON.stringify(node));
            return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
    };

    await test.ctx.transaction((tx) =>
        queueDeliveriesTo({ ...tx, db: tx.db.withPlugin(recording) }, { type: "Tested" }, {
            instanceIds: [],
            followersOf: test.alice,
        })
    );

    assertEquals(tables.filter((query) => query.includes('"follows"')), []);
    const [job, ...others] = await fanOutJobs(test.ctx);
    assertEquals(others, []);
    assertEquals(job.payload, {
        bodyId: (await test.bodies())[0],
        instanceIds: [],
        followersOf: test.alice,
    });
    assertEquals(
        await test.ctx.db.selectFrom("jobs").select("id").where("queue", "=", deliverQueue)
            .execute(),
        [],
    );

    assertEquals((await test.queued()).map((each) => each.domain), ["b.example", "c.example"]);
});

Deno.test("followers are those when the entity is sent, and so are blocks", async () => {
    await using test = await open();
    await createInstance(test.ctx, "e.example");
    await addFollowers(test.ctx, test.alice, 2, ["b.example", "e.example"]);

    await test.ctx.transaction((tx) =>
        queueDeliveriesTo(tx, { type: "Tested" }, {
            instanceIds: ["c.example"],
            followersOf: test.alice,
        })
    );
    await test.ctx.db.deleteFrom("follows").where("follower_id", "=", "follower0").execute();
    await blockDomain(test.ctx, "c.example");
    await recordUnreachable(test.ctx, "e.example");
    test.clock.advance(7 * 24 * 60 * 60_000);
    await recordUnreachable(test.ctx, "e.example");

    assertEquals(await test.queued(), []);
    // Sent nowhere, so it isn't kept.
    assertEquals(await test.bodies(), []);
});

Deno.test("followers on more instances than a query can name are all sent it", async () => {
    await using test = await open();
    const domains = Array.from({ length: 1001 }, (_, i) => `i${i}.example`);
    for (const batch of batchesOf(domains, 500)) {
        await test.ctx.db.insertInto("instances")
            .values(batch.map((domain) => ({
                id: domain,
                domain,
                protocol: "versia" as const,
                public_key: null,
                key_fetched_at: null,
                created_at: test.clock.now(),
            })))
            .execute();
    }
    await addFollowers(test.ctx, test.alice, domains.length, domains);
    let lookups = 0;
    const counting: KyselyPlugin = {
        transformQuery: ({ node }) => {
            if (node.kind === "SelectQueryNode" && JSON.stringify(node).includes('"instances"')) {
                lookups++;
            }

            return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
    };

    await test.ctx.transaction((tx) =>
        queueDeliveriesTo(tx, { type: "Tested" }, { instanceIds: [], followersOf: test.alice })
    );
    const [job] = await fanOutJobs(test.ctx);
    await fanOutHandler({ ...test.ctx, db: test.ctx.db.withPlugin(counting) }, job);

    assertEquals((await test.queued()).length, domains.length);
    // Looked up a batch at a time, so no query names too many.
    assertEquals(lookups, 2);
});

Deno.test("an entity for every instance goes to each one Verso knows and may send to", async () => {
    await using test = await open();

    await test.ctx.transaction((tx) =>
        queueDeliveriesTo(tx, { type: "Tested" }, { instanceIds: [], everyInstance: true })
    );

    assertEquals((await test.queued()).map((job) => job.domain), ["b.example", "c.example"]);
});

Deno.test("what a local user deleted since queued isn't sent, except their Deletes", async () => {
    await using test = await open();
    await test.send(["b1"]);
    const removed = deleteEntity(test.ctx, test.alice, "User", test.alice);
    await test.ctx.transaction((tx) =>
        queueDeliveriesTo(tx, removed, { instanceIds: ["c.example"] })
    );

    await deleteAccount(test.ctx, test.alice);

    const jobs = await test.queued();
    assertEquals(jobs.map((job) => [job.domain, JSON.parse(job.body).type]), [
        ["c.example", "Delete"],
    ]);
    assertEquals((await test.bodies()).length, 1);
});

Deno.test("a fan-out run again queues no delivery twice", async () => {
    await using test = await open();
    await test.send(["b1", "c1"]);
    const [job] = await fanOutJobs(test.ctx);

    await fanOutHandler(test.ctx, job);
    await fanOutHandler(test.ctx, job);

    const keys = await test.ctx.db.selectFrom("jobs").select("dedupe_key")
        .where("queue", "=", deliverQueue).orderBy("dedupe_key").execute();
    const [bodyId] = await test.bodies();
    assertEquals(keys.map((row) => row.dedupe_key), [
        `${deliverQueue}:${bodyId}:b.example`,
        `${deliverQueue}:${bodyId}:c.example`,
    ]);
});

Deno.test("entities are sent in the order they were queued, whichever fans out first", async () => {
    await using test = await open();
    await test.send(["b1"]);
    test.clock.advance(1000);
    const first = (await test.bodies())[0];
    await test.send(["b1"]);
    const [earlier, later] = await fanOutJobs(test.ctx);

    test.clock.advance(1000);
    await fanOutHandler(test.ctx, later);
    await fanOutHandler(test.ctx, earlier);

    const deliveries = await test.ctx.db.selectFrom("jobs").select(["payload", "run_at"])
        .where("queue", "=", deliverQueue).orderBy("run_at").orderBy("id").execute();
    assertEquals(deliveries.map((row) => row.payload.bodyId)[0], first);
    assertEquals(deliveries.map((row) => row.run_at), [earlier.created_at, later.created_at]);
});

Deno.test("a fan-out that dies keeps only its entity", () => {
    assertEquals(
        fanOutDeadPayload({ bodyId: "x", instanceIds: ["b.example"], followersOf: "alice" }),
        { bodyId: "x" },
    );
    assertEquals(fanOutDeadPayload({ domain: "b.example" }), {});
});

Deno.test("a job that isn't a fan-out is given up on", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: fanOutQueue, payload: { domain: "b.example" } });

    assertEquals(await fanOut(test.ctx), 1);
    const [dead] = await fanOutJobs(test.ctx);
    assertStringIncludes(dead.last_error ?? "", "isn't a fan-out job");
});
