import { assertEquals, assertNotEquals } from "@std/assert";
import { testDatabaseKind } from "../db/testing.ts";
import { rotateInstanceKey } from "../instances/keys.ts";
import type { Context } from "../kernel/context.ts";
import { memoryPubSub } from "../kernel/pubsub.ts";
import { blockDomain, unblockDomain } from "../moderation/domain_blocks.ts";
import { federation } from "../services.ts";
import { createTestContext } from "../testing/context.ts";
import { forgetWhenTold } from "./caches.ts";

/** A test, and other processes on its database: one told of changes, and one not. */
const open = async () => {
    const test = await createTestContext({ pubsub: memoryPubSub() });
    const told: Context = { ...test.ctx, federation: federation() };
    const deaf: Context = { ...test.ctx, federation: federation() };
    forgetWhenTold(told);

    return { ...test, told, deaf };
};

Deno.test("blocks apply at once in every process told of them, and within a minute in others", async () => {
    await using test = await open();
    const blocked = (ctx: Context) => ctx.federation.isBlocked(ctx, "evil.example");
    const everywhere = async () => [
        await blocked(test.ctx),
        await blocked(test.told),
        await blocked(test.deaf),
    ];
    assertEquals(await everywhere(), [false, false, false]);

    await test.ctx.transaction((tx) => blockDomain(tx, "evil.example"));
    assertEquals(await everywhere(), [true, true, false]);

    test.clock.advance(60_000);
    assertEquals(await everywhere(), [true, true, true]);

    await unblockDomain(test.ctx, "evil.example");
    assertEquals(await everywhere(), [false, false, true]);
});

Deno.test({
    name: "on Postgres, a block isn't kept unapplied by reads while it commits",
    ignore: testDatabaseKind === "pglite" || testDatabaseKind === "sqlite",
    fn: async () => {
        await using test = await open();
        const blocked = () => test.ctx.federation.isBlocked(test.ctx, "evil.example");

        await test.ctx.transaction(async (tx) => {
            await blockDomain(tx, "evil.example");
            // On another connection, so before the block.
            assertEquals(await blocked(), false);
        });
        assertEquals(await blocked(), true);
    },
});

Deno.test("a new key is signed with at once in every process told of it", async () => {
    await using test = await open();
    const keys = () =>
        Promise.all(
            [test.ctx, test.told, test.deaf].map(async (ctx) =>
                (await ctx.federation.instanceKey(ctx)).publicKey
            ),
        );
    const [first] = await keys();

    const rotated = await rotateInstanceKey(test.ctx);
    assertNotEquals(rotated, first);
    assertEquals(await keys(), [rotated, rotated, first]);
});
