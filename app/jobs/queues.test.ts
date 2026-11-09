import { assertEquals } from "@std/assert";
import { fanOutQueue } from "../federation/deliver.ts";
import { resanitiseQueue, resanitiseStartQueue } from "../federation/resanitising.ts";
import { deliveryOf } from "../federation/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { enqueue } from "./job_queries.ts";
import { queues, tasks } from "./queues.ts";
import { drain } from "./worker.ts";

Deno.test("delivered entities are cleaned up every hour", async () => {
    await using test = await createTestContext();
    const queue = "delivery-bodies-cleanup";
    assertEquals(tasks.filter((task) => task.queue === queue), [{ queue, every: "hour" }]);

    await deliveryOf(test.ctx, "b.example", "{}");
    test.clock.advance(test.ctx.settings.deliveryMs);
    await enqueue(test.ctx, { queue, payload: {} });
    await drain(test.ctx, { [queue]: queues[queue] });

    assertEquals(await test.ctx.db.selectFrom("delivery_bodies").selectAll().execute(), []);
});

Deno.test("each worker fans out one entity at a time, so they are sent in order", () => {
    assertEquals(queues[fanOutQueue].concurrency, 1);
});

Deno.test("stored remote HTML is sanitised again from an hourly start, one job at a time", () => {
    assertEquals(tasks.filter((task) => task.queue === resanitiseStartQueue), [
        { queue: resanitiseStartQueue, every: "hour" },
    ]);
    assertEquals(queues[resanitiseQueue].concurrency, 1);
});
