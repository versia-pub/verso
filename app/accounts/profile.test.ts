import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import { updateProfile } from "./profile.ts";

Deno.test("a remote account's profile isn't changed here", async () => {
    await using test = await createTestContext();
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

    await updateProfile(test.ctx, "bob", { displayName: "Changed" });

    const { display_name } = await test.ctx.db.selectFrom("accounts")
        .select("display_name")
        .executeTakeFirstOrThrow();
    assertEquals(display_name, "");
});
