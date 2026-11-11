import { assertEquals } from "@std/assert";
import type { KyselyPlugin } from "kysely";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import { unready } from "./readiness.ts";

/** Makes every query's result what `result` gives instead. */
const answering = (result: () => Promise<never>): KyselyPlugin => ({
    transformQuery: ({ node }) => node,
    transformResult: result,
});

Deno.test("a process is ready once the database answers and it hears the others", async () => {
    await using test = await createTestContext();

    assertEquals(await unready(test.ctx, () => true), undefined);
    assertEquals(await unready(test.ctx, () => false), "pubsub");
});

Deno.test("a process isn't ready while the database fails or doesn't answer in time", async () => {
    await using test = await createTestContext();
    const failing = test.ctx.db.withPlugin(
        answering(() => Promise.reject(new Error("db.internal"))),
    );
    const silent = test.ctx.db.withPlugin(answering(() => new Promise<never>(() => {})));

    assertEquals(await unready({ ...test.ctx, db: failing }, () => true), "database");
    assertEquals(await unready({ ...test.ctx, db: silent }, () => true, 10), "database");
});

Deno.test("the readiness check says what isn't ready, but not why", async () => {
    await using test = await createTestContext();
    const failing = test.ctx.db.withPlugin(
        answering(() => Promise.reject(new Error("db.internal"))),
    );
    const check = async (app: ReturnType<typeof createTestApp>) => {
        const response = await app.request("/health/ready");
        return [response.status, await response.text()];
    };

    assertEquals(await check(createTestApp(test.ctx, [])), [200, "OK"]);
    assertEquals(await check(createTestApp(test.ctx, [], { listening: () => true })), [200, "OK"]);
    assertEquals(
        await check(createTestApp(test.ctx, [], { listening: () => false })),
        [503, "pubsub"],
    );
    assertEquals(await check(createTestApp({ ...test.ctx, db: failing }, [])), [503, "database"]);
});
