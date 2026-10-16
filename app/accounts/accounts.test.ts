import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import { findLocalAccount } from "./accounts.ts";
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
