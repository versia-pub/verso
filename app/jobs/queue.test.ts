import { assertEquals, assertRejects } from "@std/assert";
import type { Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { testDatabase } from "../db/testing.ts";
import { fakeClock } from "../kernel/clock.ts";
import { createContext } from "../kernel/context.ts";
import { countingRandom, idGenerator } from "../kernel/ids.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { enqueue } from "./queue.ts";

const firstId = "019b76da-a800-7000-8000-000000000001";

const open = async () => {
    const db = await testDatabase<Database>();
    await migrate(db);
    const clock = fakeClock();
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder("social.example"),
        db,
    });
    return { ctx, [Symbol.asyncDispose]: () => db.destroy() };
};

Deno.test("an enqueued job is due now with its attempts unused", async () => {
    await using test = await open();
    const id = await enqueue(test.ctx, { queue: "deliver", payload: { to: "b.test", n: [1] } });
    assertEquals(id, firstId);
    const now = test.ctx.clock.now();
    assertEquals(await test.ctx.db.selectFrom("jobs").selectAll().execute(), [{
        id: firstId,
        queue: "deliver",
        payload: { to: "b.test", n: [1] },
        priority: 0,
        run_at: now,
        attempts: 0,
        max_attempts: 10,
        lease_owner: null,
        lease_expires_at: null,
        dedupe_key: null,
        last_error: null,
        created_at: now,
    }]);
});

Deno.test("a job exists only if the work that enqueued it commits", async () => {
    await using test = await open();
    await assertRejects(() =>
        test.ctx.transaction(async (tx) => {
            await enqueue(tx, { queue: "deliver", payload: {} });
            throw new Error("oops");
        })
    );
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
    await test.ctx.transaction((tx) => enqueue(tx, { queue: "deliver", payload: {} }));
    assertEquals((await test.ctx.db.selectFrom("jobs").select("id").execute()).length, 1);
});

Deno.test("a dedupe key that is already queued adds nothing", async () => {
    await using test = await open();
    const job = { queue: "cleanup", payload: {}, dedupeKey: "cleanup:2026-01-01T00" };
    assertEquals(await enqueue(test.ctx, job), firstId);
    assertEquals(await enqueue(test.ctx, { ...job, payload: { again: true } }), undefined);
    assertEquals(await test.ctx.db.selectFrom("jobs").select(["id", "payload"]).execute(), [
        { id: firstId, payload: {} },
    ]);
    // Jobs without a key never collide.
    await enqueue(test.ctx, { queue: "cleanup", payload: {} });
    await enqueue(test.ctx, { queue: "cleanup", payload: {} });
    assertEquals((await test.ctx.db.selectFrom("jobs").select("id").execute()).length, 3);
});
