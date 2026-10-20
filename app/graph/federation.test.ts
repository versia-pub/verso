import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { followCollections } from "./federation.ts";
import { followsFrom } from "./follow_queries.ts";
import { follow, unfollow } from "./follows.ts";

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

/** The entities queued for other instances, by domain. */
const queued = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job) => [job.domain, JSON.parse(job.body)]);

Deno.test("only local users' follows of other instances' users are sent", async () => {
    await using test = await open();
    const sent = {
        created_at: test.clock.now().toISOString(),
        author: "alice",
        followee: "b.example:carol",
    };

    // Of the follows made, only alice's of carol is sent.
    assertEquals(await queued(test.ctx), [["b.example", { type: "Follow", ...sent }]]);

    await unfollow(test.ctx, "bob", "alice");
    await unfollow(test.ctx, "carol", "alice");
    await unfollow(test.ctx, "alice", "carol");
    assertEquals((await queued(test.ctx)).slice(1), [["b.example", { type: "Unfollow", ...sent }]]);
});

/** a.test, with alice, and bob, a user on b.test, which sends whatever it is told to. */
const openNetwork = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", {
        type: "User",
        id: "bob",
        created_at: "2026-01-01T00:00:00Z",
        username: "bob",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);

    /**
     * Has b.test send `entity` to a.test, which takes it in. Each is sent a second after the last,
     * so none is taken for one sent again.
     */
    const send = async (entity: Record<string, string>, from = b) => {
        network.clock.advance(1000);
        const body = { created_at: network.clock.now().toISOString(), ...entity };
        assertEquals((await from.send("https://a.test/.versia/v0.6/inbox", { body })).status, 202);
        await network.drain();
    };

    /** Whether alice follows bob, or asked to, if either. */
    const state = async () => {
        const [row] = await followsFrom(a, alice, [bob]);
        return row && (row.accepted ? "following" : "requested");
    };

    return {
        network,
        a,
        alice,
        bob,
        send,
        state,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a follow of another instance's user is sent there, and waits for them", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;

    assertEquals(await follow(a, alice, bob), "requested");
    await test.network.drain();
    const [request] = test.network.transport.sent.filter((sent) => sent.method === "POST");
    assertEquals(request?.url, "https://b.test/.versia/v0.6/inbox");
    assertEquals(await request?.json(), {
        type: "Follow",
        created_at: test.network.clock.now().toISOString(),
        author: alice,
        followee: "b.test:bob",
    });

    await test.send({ type: "FollowAccept", author: "bob", follower: `a.test:${alice}` });
    assertEquals(await test.state(), "following");
    const counted = await a.db.selectFrom("accounts").select(["following_count", "followers_count"])
        .where("id", "in", [alice, bob]).orderBy("id").execute();
    assertEquals(counted.map((row) => [row.following_count, row.followers_count]).sort(), [
        [0, 1],
        [1, 0],
    ]);

    // Accepting again changes nothing.
    await test.send({ type: "FollowAccept", author: "b.test:bob", follower: `a.test:${alice}` });
    assertEquals(await test.state(), "following");
});

Deno.test("another instance's user rejects a request, or removes a follower", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;
    const answer = (type: string) =>
        test.send({ type, author: "bob", follower: `a.test:${alice}` });

    await follow(a, alice, bob);
    await answer("FollowReject");
    assertEquals(await test.state(), undefined);

    await follow(a, alice, bob);
    await answer("FollowAccept");
    await answer("FollowReject");
    assertEquals(await test.state(), undefined);
    const alices = await a.db.selectFrom("accounts").select("following_count")
        .where("id", "=", alice).executeTakeFirstOrThrow();
    assertEquals(alices.following_count, 0);

    // Nothing is sent back: b.test was only told of the two follows.
    await test.network.drain();
    const sent = test.network.transport.sent.filter((request) =>
        request.method === "POST" && new URL(request.url).host === "b.test"
    );
    assertEquals(await Promise.all(sent.map(async (request) => (await request.json()).type)), [
        "Follow",
        "Follow",
    ]);
});

Deno.test("only the followee's instance answers for them, and only about local users", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;
    const c = await addEvilInstance(test.network, "c.test");
    await follow(a, alice, bob);

    await test.send({ type: "FollowAccept", author: "b.test:bob", follower: `a.test:${alice}` }, c);
    await test.send({ type: "FollowAccept", author: "bob", follower: alice });
    await test.send({ type: "FollowAccept", author: "bob", follower: "a.test:nobody" });
    await test.send({ type: "FollowAccept", author: "nobody", follower: `a.test:${alice}` });
    assertEquals(await test.state(), "requested");

    const errors = await a.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", "inbox").where("last_error", "is not", null).orderBy("created_at")
        .execute();
    assertEquals(errors.length, 2);
    assertStringIncludes(
        errors[0].last_error ?? "",
        "c.test may not send this FollowAccept, which only b.test may",
    );
    assertStringIncludes(errors[1].last_error ?? "", `${alice} isn't a user here`);
});
