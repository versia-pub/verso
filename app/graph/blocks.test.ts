import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { blocksBetween } from "./block_queries.ts";
import { block, unblock } from "./blocks.ts";
import { followsFrom } from "./follow_queries.ts";
import { follow } from "./follows.ts";

/** alice, bob, who follow each other, and carol. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "bob", "alice");

    /** Whether `from` follows `to`, or asked to. */
    const state = async (from: string, to: string) => {
        const [row] = await followsFrom(test.ctx, from, [to]);
        return row && (row.accepted ? "following" : "requested");
    };

    return { ...test, state };
};

Deno.test("an account blocks others, once each, and stops", async () => {
    await using test = await open();

    assertEquals(await block(test.ctx, "alice", "bob"), true);
    assertEquals(await block(test.ctx, "alice", "carol"), true);
    // Again, it is the same block.
    assertEquals(await block(test.ctx, "alice", "bob"), true);
    assertEquals(await blocksBetween(test.ctx, "alice", ["bob", "carol"]), {
        blocking: new Set(["bob", "carol"]),
        blockedBy: new Set(),
    });
    assertEquals(await blocksBetween(test.ctx, "bob", ["alice", "carol"]), {
        blocking: new Set(),
        blockedBy: new Set(["alice"]),
    });

    assertEquals(await unblock(test.ctx, "alice", "bob"), true);
    assertEquals(await unblock(test.ctx, "alice", "bob"), false);
    assertEquals(await blocksBetween(test.ctx, "alice", ["bob", "carol"]), {
        blocking: new Set(["carol"]),
        blockedBy: new Set(),
    });
});

Deno.test("only another account that is there can be blocked", async () => {
    await using test = await open();

    assertEquals(await block(test.ctx, "alice", "alice"), false);
    assertEquals(await block(test.ctx, "alice", "missing"), false);
    assertEquals((await blocksBetween(test.ctx, "alice", ["alice", "missing"])).blocking.size, 0);
});

Deno.test("a block ends no follows, and a blocked account follows as it would", async () => {
    await using test = await open();
    await block(test.ctx, "alice", "bob");
    await block(test.ctx, "alice", "carol");

    assertEquals(await test.state("alice", "bob"), "following");
    assertEquals(await test.state("bob", "alice"), "following");
    assertEquals(await follow(test.ctx, "carol", "alice"), "following");
});

Deno.test("blocking another instance's user tells it nothing", async () => {
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

    await block(a, alice, bobOnA);
    await network.drain();

    assertEquals(network.transport.sent.slice(sent), []);
    assertEquals((await followsFrom(b, bob, [aliceOnB]))[0]?.accepted, true);
});
