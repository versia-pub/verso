import { assertEquals } from "@std/assert";
import { fakeClock } from "../kernel/clock.ts";
import { createTestContext } from "../testing/context.ts";
import { claim, complete, deleteExpiredJobs } from "./job_queries.ts";
import { schedule, type Task } from "./scheduler.ts";

const minute = 60_000;

const open = async () => {
    const test = await createTestContext({ clock: fakeClock(new Date("2026-10-14T03:20:00Z")) });
    const ctx = test.ctx;

    const jobs = () =>
        ctx.db.selectFrom("jobs").select(["dedupe_key", "keep_until", "finished_at"])
            .orderBy("dedupe_key").execute();

    return { ...test, jobs };
};

const cleanup: Task[] = [{ queue: "cleanup", every: "hour" }];

Deno.test("each period's job is created once, however often scheduling runs", async () => {
    await using test = await open();

    await schedule(test.ctx, cleanup);
    test.clock.advance(30 * minute);
    await schedule(test.ctx, cleanup);

    assertEquals(await test.jobs(), [{
        dedupe_key: "cleanup:2026-10-14T03",
        keep_until: new Date("2026-10-14T04:00:00Z"),
        finished_at: null,
    }]);
});

Deno.test("a finished job is kept until its period ends, so it isn't created again", async () => {
    await using test = await open();

    await schedule(test.ctx, cleanup);
    const [job] = await claim(test.ctx, {
        queue: "cleanup",
        worker: "w1",
        limit: 1,
        leaseMs: minute,
    });

    await complete(test.ctx, job);
    await schedule(test.ctx, cleanup);

    assertEquals(await test.jobs(), [{
        dedupe_key: "cleanup:2026-10-14T03",
        keep_until: new Date("2026-10-14T04:00:00Z"),
        finished_at: test.clock.now(),
    }]);

    assertEquals(
        await claim(test.ctx, { queue: "cleanup", worker: "w1", limit: 1, leaseMs: minute }),
        [],
    );

    test.clock.advance(40 * minute);
    await schedule(test.ctx, cleanup);
    await deleteExpiredJobs(test.ctx);

    assertEquals((await test.jobs()).map((row) => row.dedupe_key), ["cleanup:2026-10-14T04"]);
});

Deno.test("periods are minutes, hours or days in UTC", async () => {
    await using test = await open();

    await schedule(test.ctx, [
        { queue: "a", every: "minute" },
        { queue: "b", every: "hour" },
        { queue: "c", every: "day" },
    ]);

    assertEquals(await test.jobs(), [
        {
            dedupe_key: "a:2026-10-14T03:20",
            keep_until: new Date("2026-10-14T03:21:00Z"),
            finished_at: null,
        },
        {
            dedupe_key: "b:2026-10-14T03",
            keep_until: new Date("2026-10-14T04:00:00Z"),
            finished_at: null,
        },
        {
            dedupe_key: "c:2026-10-14",
            keep_until: new Date("2026-10-15T00:00:00Z"),
            finished_at: null,
        },
    ]);
});
