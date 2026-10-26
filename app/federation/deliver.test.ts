import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { recordReached, recordUnreachable } from "../instances/reachability.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context, DomainEvent, Subscriber } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { DeliverJob, deliverQueue, queueDeliveries } from "./deliver.ts";

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

/** alice here, two users on b.example, one on c.example, and one on the blocked d.example. */
const open = async () => {
    const test = await createTestContext({ subscribers: [deliverTested] });
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

    /** The deliveries queued, by domain. */
    const queued = async () =>
        (await test.ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
            .execute())
            .map((job) => DeliverJob.parse(job.payload))
            .sort((a, b) => a.domain.localeCompare(b.domain));

    return { ...test, alice, send, queued };
};

Deno.test("an entity is queued once for each instance its recipients are on", async () => {
    await using test = await open();

    await test.send(["b1", "c1", "b2", "d1", test.alice, "missing"]);

    const jobs = await test.queued();
    assertEquals(jobs.map((job) => job.domain), ["b.example", "c.example"]);
    assertEquals(jobs[0].body, jobs[1].body);
    assertEquals(JSON.parse(jobs[0].body).username, "alice");

    // Grouped by instance, and given up on by age, not by how often they were tried.
    const rows = await test.ctx.db.selectFrom("jobs").select(["group_key", "max_attempts"])
        .orderBy("group_key").execute();
    assertEquals(rows, [
        { group_key: "b.example", max_attempts: 1000 },
        { group_key: "c.example", max_attempts: 1000 },
    ]);
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
});
