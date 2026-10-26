import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { follow } from "./follows.ts";
import { mutePage, mutesOf } from "./mute_queries.ts";
import { mute, unmute } from "./mutes.ts";

const forGood = { notifications: true, duration: 0 };

/** alice, bob and carol. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    /** How alice mutes each of the others, if she does. */
    const muted = async () =>
        Object.fromEntries(
            [...await mutesOf(test.ctx, "alice", ["bob", "carol"])].map(([id, row]) => [
                id,
                [row.notifications, row.expires_at?.toISOString() ?? null],
            ]),
        );

    return { ...test, muted };
};

Deno.test("an account mutes others, for good or a while, and changes how, or stops", async () => {
    await using test = await open();
    const now = test.clock.now().getTime();

    assertEquals(await mute(test.ctx, "alice", "bob", forGood), true);
    assertEquals(
        await mute(test.ctx, "alice", "carol", { notifications: false, duration: 60 }),
        true,
    );
    assertEquals(await test.muted(), {
        bob: [true, null],
        carol: [false, new Date(now + 60_000).toISOString()],
    });
    // Only alice mutes them.
    assertEquals((await mutesOf(test.ctx, "bob", ["alice", "carol"])).size, 0);

    // Again, it changes the mute.
    await mute(test.ctx, "alice", "bob", { notifications: false, duration: 10 });
    assertEquals((await test.muted()).bob, [false, new Date(now + 10_000).toISOString()]);

    assertEquals(await unmute(test.ctx, "alice", "carol"), true);
    assertEquals(await unmute(test.ctx, "alice", "carol"), false);
    assertEquals(Object.keys(await test.muted()), ["bob"]);
});

Deno.test("a mute for a while ends when it runs out", async () => {
    await using test = await open();
    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 60 });
    await mute(test.ctx, "alice", "carol", forGood);

    test.clock.advance(59_999);
    assertEquals(Object.keys(await test.muted()), ["bob", "carol"]);

    test.clock.advance(1);
    assertEquals(Object.keys(await test.muted()), ["carol"]);
    assertEquals(
        (await mutePage(test.ctx, "alice", { limit: 40 })).map((row) => row.account_id),
        ["carol"],
    );
    // Unmuting a mute that ran out undoes nothing.
    assertEquals(await unmute(test.ctx, "alice", "bob"), false);

    // Muted again, it is active again.
    await mute(test.ctx, "alice", "bob", forGood);
    assertEquals(Object.keys(await test.muted()), ["bob", "carol"]);
});

Deno.test("only another account that is there can be muted", async () => {
    await using test = await open();

    assertEquals(await mute(test.ctx, "alice", "alice", forGood), false);
    assertEquals(await mute(test.ctx, "alice", "missing", forGood), false);
    assertEquals((await mutesOf(test.ctx, "alice", ["alice", "missing"])).size, 0);
});

Deno.test("muting another instance's user tells it nothing", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const bob = await createLocalAccount(b, "bob");
    const aliceOnB = await b.federation.resolve(b, { host: "a.test", id: alice }, "User");
    assertExists(aliceOnB);
    await follow(b, bob, aliceOnB);
    await network.drain();
    const bobOnA = (await a.db.selectFrom("accounts").select("id").where("remote_id", "=", bob)
        .executeTakeFirstOrThrow()).id;
    const sent = network.transport.sent.length;

    await mute(a, alice, bobOnA, forGood);
    await network.drain();

    assertEquals(network.transport.sent.slice(sent), []);
});
