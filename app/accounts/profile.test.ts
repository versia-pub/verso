import { assertEquals, assertFalse } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { isProfileUpdated } from "./events.ts";
import { updateProfile } from "./profile.ts";
import { createLocalAccount, createRemoteAccount } from "./testing.ts";

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

Deno.test("each change to a local profile is told, with whether it unlocked it", async () => {
    const events: unknown[] = [];
    await using test = await createTestContext({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "bob", "b.example");

    await updateProfile(test.ctx, "alice", {});
    await updateProfile(test.ctx, "alice", { locked: false });
    await updateProfile(test.ctx, "alice", { locked: true });
    await updateProfile(test.ctx, "alice", { locked: true });
    await updateProfile(test.ctx, "alice", { displayName: "Alice" });
    await updateProfile(test.ctx, "alice", { locked: false });
    await updateProfile(test.ctx, "bob", { locked: false });
    await updateProfile(test.ctx, "nobody", {});

    const changed = (unlocked: boolean) => ({
        type: "accounts.profile_updated",
        accountId: "alice",
        unlocked,
    });
    assertEquals(events, [
        changed(false),
        changed(false),
        changed(false),
        changed(false),
        changed(false),
        changed(true),
    ]);
    assertFalse(isProfileUpdated({ type: "graph.unfollowed" }));
});
