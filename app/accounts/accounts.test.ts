import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { findLocalAccount } from "./account_queries.ts";
import { createLocalAccount } from "./testing.ts";

Deno.test("only local accounts are found by username", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "bob",
            username: "bob",
            instance_id: "b.example",
            remote_id: "1",
            created_at: test.clock.now(),
        })
        .execute();

    assertEquals((await findLocalAccount(test.ctx, "Alice"))?.id, "alice");
    assertEquals(await findLocalAccount(test.ctx, "bob"), undefined);
});
