import { assertEquals, assertRejects } from "@std/assert";
import { enqueue } from "../jobs/job_queries.ts";
import type { Queue } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { createNetwork } from "./network.ts";

Deno.test("instances reach each other at their domains, until one goes down", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;

    const response = await a.transport(new Request("https://b.test/health/live"));
    assertEquals(await response.text(), "ok");

    network.transport.down.add("b.test");
    await assertRejects(() => a.transport(new Request("https://b.test/health/live")), TypeError);
});

Deno.test("instances share one clock", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);

    network.clock.advance(60_000);

    assertEquals(
        network.instances["a.test"].ctx.clock.now(),
        network.instances["b.test"].ctx.clock.now(),
    );
});

Deno.test("drain runs jobs on every instance, including ones caused on another", async () => {
    const ran: string[] = [];

    // Each job enqueues the next one on the other instance, as a delivery would.
    const contexts = new Map<string, Context>();
    const queues: Record<string, Queue> = {
        relay: {
            handler: async (ctx, job) => {
                const hops = job.payload.hops as number;
                ran.push(`${ctx.urls.origin} ${hops}`);

                const next = ctx.urls.origin === "https://a.test" ? "b.test" : "a.test";
                const other = contexts.get(next);

                if (hops > 0 && other) {
                    await enqueue(other, {
                        queue: "relay",
                        payload: { hops: hops - 1 },
                    });
                }
            },
            concurrency: 1,
        },
    };

    await using network = await createNetwork(["a.test", "b.test"], { queues });
    for (const [domain, { ctx }] of Object.entries(network.instances)) contexts.set(domain, ctx);

    await enqueue(network.instances["a.test"].ctx, { queue: "relay", payload: { hops: 3 } });

    assertEquals(await network.drain(), 4);
    assertEquals(ran, [
        "https://a.test 3",
        "https://b.test 2",
        "https://a.test 1",
        "https://b.test 0",
    ]);

    assertEquals(await network.drain(), 0);
});

Deno.test("each domain can only be used once", async () => {
    await assertRejects(
        () => createNetwork(["a.test", "a.test"]),
        Error,
        "Domains must be different",
    );
});
