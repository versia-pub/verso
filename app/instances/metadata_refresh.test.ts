import { assertEquals } from "@std/assert";
import { enqueue } from "../jobs/job_queries.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { createTestContext } from "../testing/context.ts";
import { metadataRefreshQueue, metadataRefreshStartQueue } from "./metadata_refresh.ts";
import { createInstance, keyPair, metadataServer } from "./testing.ts";

const hour = 3_600_000;

const open = async (options: { blocked?: readonly string[] } = {}) => {
    const transport = fakeTransport();
    const test = await createTestContext({
        transport,
        federation: {
            isBlocked: (_ctx, domain) =>
                Promise.resolve(options.blocked?.includes(domain) ?? false),
        },
    });

    /** Stores an instance with a key that was fetched `ageMs` ago, or never. */
    const store = async (
        domain: string,
        spki: string | null,
        ageMs: number | null,
        unreachable = false,
    ) => {
        await createInstance(test.ctx, domain);
        await test.ctx.db.updateTable("instances")
            .set({
                public_key: spki,
                key_fetched_at: ageMs === null
                    ? null
                    : new Date(test.clock.now().getTime() - ageMs),
                unreachable_since: unreachable ? test.clock.now() : null,
            })
            .where("domain", "=", domain)
            .execute();
    };

    const row = (domain: string) =>
        test.ctx.db.selectFrom("instances")
            .select(["public_key", "key_fetched_at", "takes_messages"])
            .where("domain", "=", domain)
            .executeTakeFirstOrThrow();

    const sweep = async () => {
        await enqueue(test.ctx, { queue: metadataRefreshStartQueue, payload: {} });
        await drain(test.ctx, {
            [metadataRefreshStartQueue]: queues[metadataRefreshStartQueue],
        });
    };

    const run = () => drain(test.ctx, { [metadataRefreshQueue]: queues[metadataRefreshQueue] });

    const queued = async () => (await test.ctx.db.selectFrom("jobs").select([
        "payload",
        "group_key",
        "max_attempts",
    ])
        .where("queue", "=", metadataRefreshQueue)
        .orderBy("group_key")
        .execute());

    return { ...test, transport, store, row, sweep, run, queued };
};

Deno.test("the sweep queues the instances whose key is more than a day old, or has no date", async () => {
    await using test = await open();
    const pair = await keyPair();
    await test.store("old.example", pair.spki, 24 * hour + 1);
    await test.store("undated.example", pair.spki, null);
    await test.store("fresh.example", pair.spki, 24 * hour);
    await test.store("keyless.example", null, null);
    await test.store("down.example", pair.spki, 48 * hour, true);

    await test.sweep();
    await test.sweep();

    assertEquals(await test.queued(), [
        { payload: { domain: "old.example" }, group_key: "old.example", max_attempts: 1 },
        { payload: { domain: "undated.example" }, group_key: "undated.example", max_attempts: 1 },
    ]);
});

Deno.test("a queued refresh stores the rotated key and what else the metadata says", async () => {
    await using test = await open();
    const [before, after] = [await keyPair(), await keyPair()];
    await test.store("b.example", before.spki, 25 * hour);
    test.transport.servers.set(
        "b.example",
        metadataServer("b.example", after, ["pub.versia:instance_messaging"]),
    );

    await test.sweep();
    await test.run();

    assertEquals(await test.row("b.example"), {
        public_key: after.spki,
        key_fetched_at: test.clock.now(),
        takes_messages: true,
    });
});

Deno.test("a refresh that fails leaves the stored instance as it was", async () => {
    await using test = await open();
    const [before, other] = [await keyPair(), await keyPair()];
    await test.store("down.example", before.spki, 25 * hour);
    await test.store("wrong.example", before.spki, 25 * hour);
    // Metadata for another domain isn't taken.
    test.transport.servers.set("wrong.example", metadataServer("other.example", other));
    const rows = [await test.row("down.example"), await test.row("wrong.example")];

    await test.sweep();
    await test.run();

    assertEquals(test.transport.sent.length, 2);
    assertEquals([await test.row("down.example"), await test.row("wrong.example")], rows);
});

Deno.test("a blocked instance's metadata isn't fetched", async () => {
    await using test = await open({ blocked: ["blocked.example"] });
    const [before, after] = [await keyPair(), await keyPair()];
    await test.store("blocked.example", before.spki, 25 * hour);
    test.transport.servers.set("blocked.example", metadataServer("blocked.example", after));

    await test.sweep();
    await test.run();

    assertEquals(test.transport.sent.length, 0);
    assertEquals((await test.row("blocked.example")).public_key, before.spki);
});

Deno.test("a refresh job without a domain fails for good", async () => {
    await using test = await open();

    await enqueue(test.ctx, { queue: metadataRefreshQueue, payload: { domain: 1 } });
    await test.run();

    const [job] = await test.ctx.db.selectFrom("jobs").select("last_error").execute();

    assertEquals(test.transport.sent.length, 0);
    assertEquals(job.last_error?.startsWith("PermanentFailure: "), true);
});
