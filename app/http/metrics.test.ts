import { assertEquals } from "@std/assert";
import { addFailure, setParkedUntil } from "../instances/reachability_queries.ts";
import { createInstance } from "../instances/testing.ts";
import { claim, enqueue, giveUp } from "../jobs/job_queries.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { metricsType, renderGauges } from "./metrics.ts";

const token = "a-token-long-enough-for-config-0123456789";

Deno.test("gauges are OpenMetrics text, with their labels escaped", () => {
    assertEquals(
        renderGauges([
            {
                name: "verso_waiting",
                help: 'Jobs "waiting"\\here.',
                unit: "seconds",
                samples: [{ labels: { queue: 'a"b\\c\nd' }, value: 1.5 }, { value: 0 }],
            },
            { name: "verso_none", help: "Nothing.", samples: [] },
        ]),
        [
            "# TYPE verso_waiting gauge",
            "# UNIT verso_waiting seconds",
            '# HELP verso_waiting Jobs \\"waiting\\"\\\\here.',
            'verso_waiting{queue="a\\"b\\\\c\\nd"} 1.5',
            "verso_waiting 0",
            "# TYPE verso_none gauge",
            "# HELP verso_none Nothing.",
            "# EOF",
            "",
        ].join("\n"),
    );
});

Deno.test("metrics are only for those with the token, and only if config gives one", async () => {
    await using test = await createTestContext();
    const read = async (app: ReturnType<typeof createTestApp>, authorization?: string) => {
        const response = await app.request("/metrics", {
            headers: authorization === undefined ? {} : { authorization },
        });
        await response.body?.cancel();
        return [response.status, response.headers.get("content-type")];
    };
    const app = createTestApp(test.ctx, [], { metricsToken: token });

    assertEquals((await read(createTestApp(test.ctx, []), `Bearer ${token}`))[0], 404);
    assertEquals((await read(app))[0], 401);
    assertEquals((await read(app, `Bearer ${token}x`))[0], 401);
    assertEquals((await read(app, token))[0], 401);
    assertEquals((await read(app, `Basic Bearer ${token}`))[0], 401);
    assertEquals(await read(app, `Bearer ${token}`), [200, metricsType]);
    assertEquals(await read(app, `bearer ${token}`), [200, metricsType]);
});

Deno.test("metrics say how the queues and other instances are doing", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, [], { metricsToken: token });

    await enqueue(test.ctx, { queue: "deliver", payload: {} });
    await enqueue(test.ctx, { queue: "fetch", payload: {}, maxAttempts: 1 });
    test.clock.advance(90_000);
    const [dying] = await claim(test.ctx, {
        queue: "fetch",
        worker: "w1",
        limit: 1,
        leaseMs: 60_000,
    });
    await giveUp(test.ctx, dying, "invalid");

    await createInstance(test.ctx, "b.example");
    await createInstance(test.ctx, "c.example");
    await createInstance(test.ctx, "d.example");
    await addFailure(test.ctx, "b.example");
    await addFailure(test.ctx, "c.example");
    await setParkedUntil(test.ctx, "b.example", new Date(test.clock.now().getTime() + 1));
    await setParkedUntil(test.ctx, "d.example", test.clock.now());

    const response = await app.request("/metrics", {
        headers: { authorization: `Bearer ${token}` },
    });
    const samples = (await response.text()).split("\n").filter((line) => !line.startsWith("#"));

    assertEquals(samples, [
        'verso_jobs_waiting{queue="deliver"} 1',
        'verso_jobs_waiting{queue="fetch"} 0',
        'verso_jobs_oldest_due_seconds{queue="deliver"} 90',
        'verso_jobs_oldest_due_seconds{queue="fetch"} 0',
        'verso_jobs_dead{queue="deliver"} 0',
        'verso_jobs_dead{queue="fetch"} 1',
        "verso_instances_parked 1",
        "verso_instances_unreachable 2",
        "",
    ]);
});
