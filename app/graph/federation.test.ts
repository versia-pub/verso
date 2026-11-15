import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { deleteRemoteAccount } from "../accounts/remote.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { queuedDeliveries } from "../federation/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { suspend } from "../moderation/suspensions.ts";
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
    const domain = test.ctx.urls.domain;
    const followers = (offset: number, limit: number) =>
        followCollections.subscribers(test.ctx, "alice", { offset, limit }, "b.example");

    assertEquals(await followers(0, 40), {
        author: "alice",
        total: 3,
        items: [`${domain}:bob`, "b.example:carol", `${domain}:dave`],
    });
    assertEquals(await followers(1, 1), { author: "alice", total: 3, items: ["b.example:carol"] });
    assertEquals(await followers(3, 40), { author: "alice", total: 3, items: [] });

    // Alice only requested to follow carol.
    assertEquals(
        await followCollections.subscriptions(
            test.ctx,
            "alice",
            { offset: 0, limit: 40 },
            "b.example",
        ),
        { author: "alice", total: 0, items: [] },
    );
    assertEquals(
        await followCollections.subscriptions(
            test.ctx,
            "bob",
            { offset: 0, limit: 40 },
            "b.example",
        ),
        { author: "bob", total: 1, items: [`${domain}:alice`] },
    );
});

Deno.test("a user who hides their follows shows only how many there are", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ hide_collections: true })
        .where("id", "=", "alice").execute();

    assertEquals(
        await followCollections.subscribers(
            test.ctx,
            "alice",
            { offset: 0, limit: 40 },
            "b.example",
        ),
        { author: "alice", total: 3, items: [] },
    );
});

Deno.test("only local users' follows are given, as Users' collections", async () => {
    await using test = await open();
    const page = { offset: 0, limit: 40 };

    assertEquals(
        await followCollections.subscribers(test.ctx, "carol", page, "b.example"),
        undefined,
    );
    assertEquals(
        await followCollections.subscriptions(test.ctx, "nobody", page, "b.example"),
        undefined,
    );

    const collections = registry.types.get("User")?.collections;
    assertEquals(collections?.subscribers, followCollections.subscribers);
    assertEquals(collections?.subscriptions, followCollections.subscriptions);
    assertEquals(Object.keys(collections ?? {}).toSorted(), [
        "pub.versia:likes/Dislikes",
        "pub.versia:likes/Likes",
        "pub.versia:social/Featured",
        "pub.versia:social/Notes",
        "subscribers",
        "subscriptions",
    ]);
});

/** The entities queued for remote instances, by domain. */
const queued = async (ctx: Context) =>
    (await queuedDeliveries(ctx))
        .map((job) => [job.domain, JSON.parse(job.body)]);

Deno.test("only what local users do to follows with other instances' users is sent", async () => {
    await using test = await open();
    const at = (msAgo: number) => new Date(test.clock.now().getTime() - msAgo).toISOString();
    const alice = `${test.ctx.urls.domain}:alice`;
    const request = { subscriber: alice, target: "b.example:carol", target_type: "User" };
    const answer = { subscriber: "b.example:carol", target: alice, target_type: "User" };

    // Of the follows created, alice accepted carol's, and requested to follow carol.
    assertEquals(await queued(test.ctx), [
        ["b.example", { type: "SubscribeAccept", created_at: at(1), ...answer }],
        ["b.example", { type: "Subscribe", created_at: at(0), ...request }],
    ]);

    await unfollow(test.ctx, "bob", "alice");
    await unfollow(test.ctx, "carol", "alice");
    await unfollow(test.ctx, "alice", "carol");
    await follow(test.ctx, "carol", "alice");
    await rejectFollow(test.ctx, "carol", "alice");
    await rejectFollow(test.ctx, "dave", "alice");
    assertEquals((await queued(test.ctx)).slice(2), [
        ["b.example", { type: "Unsubscribe", created_at: at(0), ...request }],
        ["b.example", { type: "SubscribeAccept", created_at: at(0), ...answer }],
        ["b.example", { type: "SubscribeReject", created_at: at(0), ...answer }],
    ]);
});

/** a.test, with alice, and bob, a user on b.test, which sends whatever it is told to. */
const openNetwork = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.7/entities/User/bob", {
        type: "User",
        id: "bob",
        created_at: "2026-01-01T00:00:00Z",
        username: "bob",
        manually_approves_subscribers: false,
        indexable: true,
    });

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);

    /**
     * Has b.test send `entity` to a.test, which receives it. Each is sent a second after the last,
     * so none is mistaken for a resend.
     */
    const send = async (entity: Record<string, string>, from = b) => {
        network.clock.advance(1000);
        const body = { created_at: network.clock.now().toISOString(), ...entity };
        assertEquals((await from.send("https://a.test/.versia/v0.7/inbox", { body })).status, 202);
        await network.drain();
    };

    /** The types of what a.test sent to b.test, in order. */
    const sentToB = async () => {
        await network.drain();
        const sent = network.transport.sent.filter((request) =>
            request.method === "POST" && new URL(request.url).host === "b.test"
        );

        return await Promise.all(sent.map(async (request) => (await request.clone().json()).type));
    };

    /** Whether alice follows bob, or has requested to, if either. */
    const state = async () => {
        const [row] = await followsFrom(a, alice, [bob]);
        return row && (row.accepted ? "following" : "requested");
    };

    return {
        network,
        a,
        alice,
        bob,
        b,
        send,
        sentToB,
        state,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

/** A Subscribe, or other subscription entity, from `subscriber` to `target`, which are Users. */
const subscription = (type: string, subscriber: string, target: string) => ({
    type,
    subscriber,
    target,
    target_type: "User",
});

Deno.test("a follow of another instance's user is sent there, and waits for them", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;

    assertEquals(await follow(a, alice, bob), "requested");
    await test.network.drain();
    const [request] = test.network.transport.sent.filter((sent) => sent.method === "POST");
    assertEquals(request?.url, "https://b.test/.versia/v0.7/inbox");
    assertEquals(await request?.json(), {
        type: "Subscribe",
        created_at: test.network.clock.now().toISOString(),
        subscriber: `a.test:${alice}`,
        target: "b.test:bob",
        target_type: "User",
    });

    await test.send(subscription("SubscribeAccept", `a.test:${alice}`, "b.test:bob"));
    assertEquals(await test.state(), "following");
    const counted = await a.db.selectFrom("accounts").select(["following_count", "followers_count"])
        .where("id", "in", [alice, bob]).orderBy("id").execute();
    assertEquals(counted.map((row) => [row.following_count, row.followers_count]).sort(), [
        [0, 1],
        [1, 0],
    ]);

    // Accepting again changes nothing.
    await test.send(subscription("SubscribeAccept", `a.test:${alice}`, "b.test:bob"));
    assertEquals(await test.state(), "following");
});

Deno.test("another instance's user rejects a request, or removes a follower", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;
    const answer = (type: string) =>
        test.send({
            type,
            subscriber: `a.test:${alice}`,
            target: "b.test:bob",
            target_type: "User",
        });

    await follow(a, alice, bob);
    await answer("SubscribeReject");
    assertEquals(await test.state(), undefined);

    await follow(a, alice, bob);
    await answer("SubscribeAccept");
    await answer("SubscribeReject");
    assertEquals(await test.state(), undefined);
    const alices = await a.db.selectFrom("accounts").select("following_count")
        .where("id", "=", alice).executeTakeFirstOrThrow();
    assertEquals(alices.following_count, 0);

    // Nothing is sent back: b.test was only told of the two follows.
    await test.network.drain();
    const sent = test.network.transport.sent.filter((request) =>
        request.method === "POST" && new URL(request.url).host === "b.test"
    );
    assertEquals(
        await Promise.all(sent.map(async (request) => (await request.clone().json()).type)),
        [
            "Subscribe",
            "Subscribe",
        ],
    );
});

Deno.test("only the followee's instance answers for them, and only about local users", async () => {
    await using test = await openNetwork();
    const { a, alice, bob } = test;
    const c = await addEvilInstance(test.network, "c.test");
    await follow(a, alice, bob);

    const accept = (subscriber: string, target: string, from = test.b) =>
        test.send(subscription("SubscribeAccept", subscriber, target), from);

    await accept(`a.test:${alice}`, "b.test:bob", c);
    await accept(`b.test:${alice}`, "b.test:bob");
    await accept("a.test:nobody", "b.test:bob");
    await accept(`a.test:${alice}`, "b.test:nobody");
    assertEquals(await test.state(), "requested");

    const errors = await a.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", "inbox").where("last_error", "is not", null).orderBy("created_at")
        .execute();
    assertEquals(errors.length, 2);
    assertStringIncludes(
        errors[0].last_error ?? "",
        "c.test may not send this SubscribeAccept, which only b.test may",
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

    /** Whether bob follows alice, or has requested to, as a.test and b.test each have it. */
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
    const ask = () => test.send(subscription("Subscribe", "b.test:bob", `a.test:${test.alice}`));
    const answers = () =>
        Promise.all(
            test.network.transport.sent
                .filter((request) =>
                    request.method === "POST" && new URL(request.url).host === "b.test"
                )
                .map(async (request) => JSON.parse(await request.clone().text()).type),
        );

    await ask();
    await ask();
    const [followed] = await followsFrom(test.a, test.bob, [test.alice]);
    assertEquals(followed?.accepted, true);
    assertEquals(await answers(), ["SubscribeAccept", "SubscribeAccept"]);

    await unfollow(test.a, test.bob, test.alice);
    await test.a.db.updateTable("accounts").set({ locked: true }).where("id", "=", test.alice)
        .execute();
    await ask();
    await ask();
    const [asked] = await followsFrom(test.a, test.bob, [test.alice]);
    assertEquals(asked?.accepted, false);
    assertEquals((await answers()).length, 2);
});

Deno.test("only a user's instance follows for them, and only local users", async () => {
    await using test = await openNetwork();
    const c = await addEvilInstance(test.network, "c.test");

    const alice = `a.test:${test.alice}`;

    await test.send(subscription("Subscribe", "b.test:bob", alice), c);
    await test.send(subscription("Subscribe", "b.test:bob", "c.test:carol"));
    await test.send(subscription("Subscribe", "b.test:bob", "a.test:nobody"));
    // b.test says there is no such user.
    await test.send(subscription("Subscribe", "b.test:nobody", alice));
    assertEquals(await test.a.db.selectFrom("follows").selectAll().execute(), []);

    const errors = await test.a.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", "inbox").where("last_error", "is not", null).orderBy("created_at")
        .execute();
    assertEquals(errors.length, 2);
    assertStringIncludes(errors[0].last_error ?? "", "c.test may not send this Subscribe");
    assertStringIncludes(errors[1].last_error ?? "", "c.test:carol isn't a user here");
});

Deno.test("a user stops following a local one, or asking to", async () => {
    await using test = await openNetwork();
    const followee = `a.test:${test.alice}`;

    await test.send(subscription("Subscribe", "b.test:bob", followee));
    await test.send(subscription("Unsubscribe", "b.test:bob", followee));
    assertEquals(await followsFrom(test.a, test.bob, [test.alice]), []);

    await test.a.db.updateTable("accounts").set({ locked: true }).where("id", "=", test.alice)
        .execute();
    await test.send(subscription("Subscribe", "b.test:bob", followee));
    await test.send(subscription("Unsubscribe", "b.test:bob", followee));
    await test.send(subscription("Unsubscribe", "b.test:nobody", followee));
    assertEquals(await followsFrom(test.a, test.bob, [test.alice]), []);
});

Deno.test("a Subscribe for a target that isn't a User is refused as invalid", async () => {
    await using test = await openNetwork();
    const body = {
        ...subscription("Subscribe", "b.test:bob", `a.test:${test.alice}`),
        target_type: "Note",
    };

    const response = await test.b.send("https://a.test/.versia/v0.7/inbox", {
        body: { created_at: test.network.clock.now().toISOString(), ...body },
    });

    assertEquals(response.status, 422);
    assertEquals(await test.a.db.selectFrom("follows").selectAll().execute(), []);
});

Deno.test("a Subscribe to a user who can't be followed is rejected, not left unanswered", async () => {
    await using test = await openNetwork();
    const ask = () => test.send(subscription("Subscribe", "b.test:bob", `a.test:${test.alice}`));

    await suspend(test.a, test.alice);
    await ask();
    assertEquals(await test.sentToB(), ["SubscribeReject"]);

    await test.a.db.updateTable("accounts").set({
        suspended_at: null,
        moved_to_account_id: test.bob,
    })
        .where("id", "=", test.alice).execute();
    await ask();
    assertEquals(await test.sentToB(), ["SubscribeReject", "SubscribeReject"]);
    assertEquals(await followsFrom(test.a, test.bob, [test.alice]), []);
});

Deno.test("a Subscribe naming a user Verso doesn't have is rejected back to its sender", async () => {
    await using test = await openNetwork();

    await test.send(subscription("Subscribe", "b.test:bob", "a.test:nobody"));
    // b.test says there is no such user.
    await test.send(subscription("Subscribe", "b.test:nobody", `a.test:${test.alice}`));
    await test.network.drain();

    const sent = await Promise.all(
        test.network.transport.sent
            .filter((request) =>
                request.method === "POST" && new URL(request.url).host === "b.test"
            )
            .map(async (request) => {
                const { type, subscriber, target, target_type } = await request.clone().json();
                return { type, subscriber, target, target_type };
            }),
    );
    assertEquals(sent, [
        subscription("SubscribeReject", "b.test:bob", "a.test:nobody"),
        subscription("SubscribeReject", "b.test:nobody", `a.test:${test.alice}`),
    ]);
});

Deno.test("a SubscribeAccept for no follow is answered with an Unsubscribe", async () => {
    await using test = await openNetwork();

    await test.send(subscription("SubscribeAccept", `a.test:${test.alice}`, "b.test:bob"));

    assertEquals(await test.sentToB(), ["Unsubscribe"]);
    assertEquals(await test.state(), undefined);
});

Deno.test("a SubscribeAccept for a follow already accepted sends nothing", async () => {
    await using test = await openNetwork();
    await follow(test.a, test.alice, test.bob);
    await test.send(subscription("SubscribeAccept", `a.test:${test.alice}`, "b.test:bob"));
    assertEquals(await test.sentToB(), ["Subscribe"]);

    await test.send(subscription("SubscribeAccept", `a.test:${test.alice}`, "b.test:bob"));

    assertEquals(await test.sentToB(), ["Subscribe"]);
    assertEquals(await test.state(), "following");
});

Deno.test("a subscription entity is only sent by the instance that sends it for its author", async () => {
    await using test = await openNetwork();
    await follow(test.a, test.alice, test.bob);

    // b.test sends an accept as if from a.test's user, and a subscribe as if from a.test's.
    await test.send(subscription("SubscribeAccept", "b.test:bob", `a.test:${test.alice}`));
    await test.send(subscription("Subscribe", `a.test:${test.alice}`, "b.test:bob"));

    assertEquals(await test.state(), "requested");
    const errors = await test.a.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", "inbox").where("last_error", "is not", null).orderBy("created_at")
        .execute();
    assertEquals(errors.length, 2);
    assertStringIncludes(
        errors[0].last_error ?? "",
        "b.test may not send this SubscribeAccept, which only a.test may",
    );
    assertStringIncludes(
        errors[1].last_error ?? "",
        "b.test may not send this Subscribe, which only a.test may",
    );
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

    // Only carol follows alice from a remote instance; erin only requested, and alice follows
    // frank.
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

    // Carol followed alice, and alice carol; carol only requested to follow bob.
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
