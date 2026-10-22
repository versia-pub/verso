import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { deleteRemoteAccount } from "../accounts/remote.ts";
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
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";
import { addFollowers } from "./testing.ts";

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
        "pub.versia:likes/Dislikes",
        "pub.versia:likes/Likes",
    ]);
});

/** The entities queued for other instances, by domain. */
const queued = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job) => [job.domain, JSON.parse(job.body)]);

Deno.test("only what local users do to follows with other instances' users is sent", async () => {
    await using test = await open();
    const at = (msAgo: number) => new Date(test.clock.now().getTime() - msAgo).toISOString();
    const request = { author: "alice", followee: "b.example:carol" };
    const answer = { author: "alice", follower: "b.example:carol" };

    // Of the follows made, alice accepted carol's, and asked to follow carol.
    assertEquals(await queued(test.ctx), [
        ["b.example", { type: "FollowAccept", created_at: at(1), ...answer }],
        ["b.example", { type: "Follow", created_at: at(0), ...request }],
    ]);

    await unfollow(test.ctx, "bob", "alice");
    await unfollow(test.ctx, "carol", "alice");
    await unfollow(test.ctx, "alice", "carol");
    await follow(test.ctx, "carol", "alice");
    await rejectFollow(test.ctx, "carol", "alice");
    await rejectFollow(test.ctx, "dave", "alice");
    assertEquals((await queued(test.ctx)).slice(2), [
        ["b.example", { type: "Unfollow", created_at: at(0), ...request }],
        ["b.example", { type: "FollowAccept", created_at: at(0), ...answer }],
        ["b.example", { type: "FollowReject", created_at: at(0), ...answer }],
    ]);
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

/** a.test with alice, and b.test with bob, who has found alice. */
const openPair = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const bob = await createLocalAccount(b, "bob");
    const aliceOnB = await b.federation.resolve(b, { host: "a.test", id: alice }, "User");
    assertExists(aliceOnB);

    const stateOf = async (ctx: Context, column: "followee_id" | "follower_id", id: string) => {
        const row = await ctx.db.selectFrom("follows").select("accepted")
            .where(column, "=", id).executeTakeFirst();
        return row && (row.accepted ? "following" : "requested");
    };

    /** Whether bob follows alice, or asked to, as a.test and b.test each have it. */
    const states =
        async () => [await stateOf(a, "followee_id", alice), await stateOf(b, "follower_id", bob)];

    /** Alice's followers and bob's follows, as their own instances count them. */
    const counts = async () => [
        (await a.db.selectFrom("accounts").select("followers_count").where("id", "=", alice)
            .executeTakeFirstOrThrow()).followers_count,
        (await b.db.selectFrom("accounts").select("following_count").where("id", "=", bob)
            .executeTakeFirstOrThrow()).following_count,
    ];

    /** Bob as a.test has him, once it has fetched him. */
    const bobOnA = async () =>
        (await a.db.selectFrom("accounts").select("id").where("remote_id", "=", bob)
            .executeTakeFirstOrThrow()).id;

    return {
        network,
        a,
        b,
        alice,
        bob,
        aliceOnB,
        states,
        counts,
        bobOnA,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a user on another instance follows a local one, who accepts at once", async () => {
    await using test = await openPair();

    assertEquals(await follow(test.b, test.bob, test.aliceOnB), "requested");
    await test.network.drain();
    assertEquals(await test.states(), ["following", "following"]);
    assertEquals(await test.counts(), [1, 1]);

    await unfollow(test.b, test.bob, test.aliceOnB);
    await test.network.drain();
    assertEquals(await test.states(), [undefined, undefined]);
    assertEquals(await test.counts(), [0, 0]);
});

Deno.test("a locked user's follower waits, and is told when they are accepted or removed", async () => {
    await using test = await openPair();
    await test.a.db.updateTable("accounts").set({ locked: true }).where("id", "=", test.alice)
        .execute();

    await follow(test.b, test.bob, test.aliceOnB);
    await test.network.drain();
    assertEquals(await test.states(), ["requested", "requested"]);

    await acceptFollow(test.a, await test.bobOnA(), test.alice);
    await test.network.drain();
    assertEquals(await test.states(), ["following", "following"]);
    assertEquals(await test.counts(), [1, 1]);

    await rejectFollow(test.a, await test.bobOnA(), test.alice);
    await test.network.drain();
    assertEquals(await test.states(), [undefined, undefined]);
    assertEquals(await test.counts(), [0, 0]);
});

Deno.test("a follower who asks again is accepted again, unless they wait to be", async () => {
    await using test = await openNetwork();
    const ask = () =>
        test.send({ type: "Follow", author: "bob", followee: `a.test:${test.alice}` });
    const answers = () =>
        test.network.transport.sent.filter((request) =>
            request.method === "POST" && new URL(request.url).host === "b.test"
        ).length;

    await ask();
    await ask();
    const [followed] = await followsFrom(test.a, test.bob, [test.alice]);
    assertEquals(followed?.accepted, true);
    assertEquals(answers(), 2);

    await unfollow(test.a, test.bob, test.alice);
    await test.a.db.updateTable("accounts").set({ locked: true }).where("id", "=", test.alice)
        .execute();
    await ask();
    await ask();
    const [asked] = await followsFrom(test.a, test.bob, [test.alice]);
    assertEquals(asked?.accepted, false);
    assertEquals(answers(), 2);
});

Deno.test("only a user's instance follows for them, and only local users", async () => {
    await using test = await openNetwork();
    const c = await addEvilInstance(test.network, "c.test");

    await test.send({ type: "Follow", author: "b.test:bob", followee: `a.test:${test.alice}` }, c);
    await test.send({ type: "Follow", author: "bob", followee: "c.test:carol" });
    await test.send({ type: "Follow", author: "bob", followee: "a.test:nobody" });
    // b.test says there is no such user.
    await test.send({ type: "Follow", author: "nobody", followee: `a.test:${test.alice}` });
    assertEquals(await test.a.db.selectFrom("follows").selectAll().execute(), []);

    const errors = await test.a.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", "inbox").where("last_error", "is not", null).orderBy("created_at")
        .execute();
    assertEquals(errors.length, 2);
    assertStringIncludes(errors[0].last_error ?? "", "c.test may not send this Follow");
    assertStringIncludes(errors[1].last_error ?? "", "c.test:carol isn't a user here");
});

Deno.test("a user stops following a local one, or asking to", async () => {
    await using test = await openNetwork();
    const followee = `a.test:${test.alice}`;

    await test.send({ type: "Follow", author: "bob", followee });
    await test.send({ type: "Unfollow", author: "bob", followee });
    assertEquals(await followsFrom(test.a, test.bob, [test.alice]), []);

    await test.a.db.updateTable("accounts").set({ locked: true }).where("id", "=", test.alice)
        .execute();
    await test.send({ type: "Follow", author: "bob", followee });
    await test.send({ type: "Unfollow", author: "bob", followee });
    await test.send({ type: "Unfollow", author: "nobody", followee });
    assertEquals(await followsFrom(test.a, test.bob, [test.alice]), []);
});

Deno.test("a changed profile is sent to the instances of its followers", async () => {
    await using test = await open();
    await createInstance(test.ctx, "c.example");
    await createRemoteAccount(test.ctx, "erin", "c.example");
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "erin", "alice");
    await follow(test.ctx, "alice", "frank");
    const before = (await queued(test.ctx)).length;

    await updateProfile(test.ctx, "alice", { displayName: "Alice" });
    await updateProfile(test.ctx, "bob", { displayName: "Bob" });

    // Only carol follows alice from another instance; erin only asked, and alice follows frank.
    const sent = (await queued(test.ctx)).slice(before);
    assertEquals(sent.map(([domain, entity]) => [domain, entity.type, entity.display_name]), [
        ["b.example", "User", "Alice"],
    ]);
});

Deno.test("a remote account deleted is uncounted from those it followed and was followed by", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "bob")
        .execute();
    await follow(test.ctx, "carol", "bob");
    await acceptFollow(test.ctx, "alice", "carol");
    const counts = async () =>
        (await test.ctx.db.selectFrom("accounts")
            .select(["id", "followers_count", "following_count"])
            .where("id", "in", ["alice", "bob"]).orderBy("id").execute())
            .map((row) => [row.id, row.followers_count, row.following_count]);
    assertEquals(await counts(), [["alice", 3, 1], ["bob", 0, 1]]);

    await deleteRemoteAccount(test.ctx, "b.example", "carol");

    // Carol followed alice, and alice carol; carol only asked to follow bob.
    assertEquals(await counts(), [["alice", 2, 0], ["bob", 0, 1]]);
});

Deno.test("a remote account deleted is uncounted from more followers than one query can name", async () => {
    await using test = await open();
    const followers = await addFollowers(test.ctx, "carol", 2500, [null]);

    await deleteRemoteAccount(test.ctx, "b.example", "carol");

    const counts = await test.ctx.db.selectFrom("accounts").select("following_count")
        .where("id", "in", [followers[0], followers[1500], followers[2499]]).execute();
    assertEquals(counts.map((row) => row.following_count), [0, 0, 0]);
});
