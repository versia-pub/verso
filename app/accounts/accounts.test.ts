import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import {
    emptyAccount,
    findLocalAccount,
    hasLocalUser,
    isAccountDeleted,
    isAccountSilenced,
    isAccountSuspended,
    isSuspended,
    setSilencedAt,
    setSuspendedAt,
} from "./account_queries.ts";
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

Deno.test("an account is suspended only by its own id, on its own instance", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "carol"]) await createLocalAccount(test.ctx, id);
    for (const domain of ["b.example", "c.example"]) await createInstance(test.ctx, domain);
    for (
        const [id, instance, remoteId] of [
            ["bob-b", "b.example", "bob"],
            ["bob-c", "c.example", "bob"],
            ["dave-b", "b.example", "dave"],
        ]
    ) {
        await test.ctx.db.insertInto("accounts")
            .values({
                id,
                username: remoteId,
                instance_id: instance,
                remote_id: remoteId,
                created_at: test.clock.now(),
            })
            .execute();
    }

    for (const id of ["alice", "bob-b"]) await setSuspendedAt(test.ctx, id, test.clock.now());

    assertEquals(await isSuspended(test.ctx, null, "alice"), true);
    assertEquals(await isSuspended(test.ctx, null, "carol"), false);
    assertEquals(await isSuspended(test.ctx, "b.example", "bob"), true);
    assertEquals(await isSuspended(test.ctx, "c.example", "bob"), false);
    assertEquals(await isSuspended(test.ctx, "b.example", "dave"), false);
});

Deno.test("an account's state is read from that account, not from any other", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "carol"]) await createLocalAccount(test.ctx, id);
    await setSuspendedAt(test.ctx, "alice", test.clock.now());
    await setSilencedAt(test.ctx, "alice", test.clock.now());
    await emptyAccount(test.ctx, "alice", test.clock.now());

    const states = async (id: string) => [
        await hasLocalUser(test.ctx, id),
        await isAccountSuspended(test.ctx, id),
        await isAccountSilenced(test.ctx, id),
        await isAccountDeleted(test.ctx, id),
    ];

    assertEquals(await states("alice"), [true, true, true, true]);
    assertEquals(await states("carol"), [true, false, false, false]);
    assertEquals(await states("nobody"), [false, false, false, false]);
});
