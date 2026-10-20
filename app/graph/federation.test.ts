import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { followCollections } from "./federation.ts";
import { follow } from "./follows.ts";

const open = async () => {
    const test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);

    for (const [follower, followee] of [["bob", "alice"], ["carol", "alice"], ["dave", "alice"]]) {
        test.clock.advance(1);
        await follow(test.ctx, follower, followee);
    }
    await follow(test.ctx, "alice", "carol");

    return test;
};

Deno.test("a user's followers are references, oldest first, a page at a time", async () => {
    await using test = await open();
    const followers = (offset: number, limit: number) =>
        followCollections.followers(test.ctx, "alice", { offset, limit }, "b.example");

    assertEquals(await followers(0, 40), {
        author: "alice",
        total: 3,
        items: ["bob", "b.example:carol", "dave"],
    });
    assertEquals(await followers(1, 1), { author: "alice", total: 3, items: ["b.example:carol"] });
    assertEquals(await followers(3, 40), { author: "alice", total: 3, items: [] });

    // Alice only asked to follow carol.
    assertEquals(
        await followCollections.following(test.ctx, "alice", { offset: 0, limit: 40 }, "b.example"),
        { author: "alice", total: 0, items: [] },
    );
    assertEquals(
        await followCollections.following(test.ctx, "bob", { offset: 0, limit: 40 }, "b.example"),
        { author: "bob", total: 1, items: ["alice"] },
    );
});

Deno.test("a user who hides their follows shows only how many there are", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ hide_collections: true })
        .where("id", "=", "alice").execute();

    assertEquals(
        await followCollections.followers(test.ctx, "alice", { offset: 0, limit: 40 }, "b.example"),
        { author: "alice", total: 3, items: [] },
    );
});

Deno.test("only local users' follows are given, as Users' collections", async () => {
    await using test = await open();
    const page = { offset: 0, limit: 40 };

    assertEquals(
        await followCollections.followers(test.ctx, "carol", page, "b.example"),
        undefined,
    );
    assertEquals(
        await followCollections.following(test.ctx, "nobody", page, "b.example"),
        undefined,
    );

    const collections = registry.types.get("User")?.collections;
    assertEquals(collections?.followers, followCollections.followers);
    assertEquals(collections?.following, followCollections.following);
    assertEquals(Object.keys(collections ?? {}).toSorted(), [
        "featured",
        "followers",
        "following",
        "outbox",
    ]);
});
