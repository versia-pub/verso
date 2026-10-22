import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { like } from "../interactions/likes.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findRemoteNoteAt } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { createNote } from "./testing.ts";
import { totalsOf } from "./total_queries.ts";
import { fetchTotalsLater, totalsQueue } from "./totals.ts";

/** bob, on b.test. */
const user = {
    type: "User",
    id: "bob",
    created_at: "2026-01-01T00:00:00Z",
    username: "bob",
    fields: [],
    manually_approves_followers: false,
    indexable: true,
};

/** bob's public note `n1`. */
const note = {
    type: "Note",
    id: "n1",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    content: { "text/plain": { content: "Hi", remote: false } },
    group: "public",
    is_sensitive: false,
    mentions: [],
    attachments: [],
    previews: [],
};

/** Where b.test serves the collection `name` of bob's note. */
const collection = (name: string) =>
    `/.versia/v0.6/entities/Note/n1/collections/${encodeURIComponent(name)}`;

/**
 * a.test, with alice, who follows bob, and b.test, which sends what it is told, with bob and the
 * totals of his note's collections given, each `undefined` for one it doesn't have.
 */
const open = async (totals: { likes?: unknown; shares?: unknown; replies?: unknown }) => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", user);
    for (
        const [name, total] of [
            ["pub.versia:likes/Likes", totals.likes],
            ["pub.versia:share/Shares", totals.shares],
            ["replies", totals.replies],
        ]
    ) {
        if (total !== undefined) b.serve(collection(name as string), { total, items: [] });
    }

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);
    await follow(a, alice, bob);
    await b.send("https://a.test/.versia/v0.6/inbox", {
        body: {
            type: "FollowAccept",
            author: "bob",
            follower: `a.test:${alice}`,
            created_at: "2026-01-01T00:00:00Z",
        },
    });
    await network.drain();

    /** Has b.test send bob's note to a.test, and a.test take it in, totals and all. */
    const send = async () => {
        const sent = await b.send("https://a.test/.versia/v0.6/inbox", { body: note });
        assertEquals(sent.status, 202);
        await network.drain();

        const row = await findRemoteNoteAt(a, "b.test", "n1");
        assertExists(row);
        return row;
    };

    /** The likes, shares and replies of bob's note, as the client API counts them. */
    const counts = async () => {
        const row = await findRemoteNoteAt(a, "b.test", "n1");
        assertExists(row);
        const [status] = await renderStatuses(a, [row], null);
        return [status.favourites_count, status.reblogs_count, status.replies_count];
    };

    /** How many requests b.test was sent for the collections of bob's note. */
    const asked = () =>
        network.transport.sent.filter((request) =>
            new URL(request.url).pathname.startsWith("/.versia/v0.6/entities/Note/n1/collections/")
        ).length;

    return {
        network,
        a,
        b,
        alice,
        send,
        counts,
        asked,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("another instance's note shows the totals its instance gives, when they are more", async () => {
    await using test = await open({ likes: 5, shares: 2, replies: 3 });
    const row = await test.send();
    const local = await createNote(test.a, test.alice);

    assertEquals(await test.counts(), [5, 2, 3]);
    assertEquals(test.asked(), 3);
    // One item is the least a page may have; Verso only needs the total.
    for (const request of test.network.transport.sent.slice(-3)) {
        assertEquals(new URL(request.url).searchParams.get("limit"), "1");
    }
    assertEquals([...(await totalsOf(test.a, [row.id])).values()], [{
        note_id: row.id,
        likes: 5,
        shares: 2,
        replies: 3,
        fetched_at: test.network.clock.now(),
    }]);

    // Alice's like is among the ones b.test counts, so it adds nothing.
    await like(test.a, test.alice, row.id);
    assertEquals(await test.counts(), [5, 2, 3]);

    // Fetched again, the totals are what b.test says now.
    test.b.serve(collection("pub.versia:likes/Likes"), { total: 7, items: [] });
    await fetchTotalsLater(test.a, row);
    await test.network.drain();
    assertEquals(await test.counts(), [7, 2, 3]);
    assertEquals(await totalsOf(test.a, ["other", local.id]), new Map());
});

Deno.test("what Verso counted shows when it is more than its instance gives", async () => {
    await using test = await open({ likes: 0, shares: 0, replies: 0 });
    const row = await test.send();
    await like(test.a, test.alice, row.id);

    assertEquals(await test.counts(), [1, 0, 0]);
});

Deno.test("a collection its instance doesn't have has no total, and the rest are kept", async () => {
    await using test = await open({ likes: 4 });
    const row = await test.send();

    assertEquals(await test.counts(), [4, 0, 0]);
    const [totals] = (await totalsOf(test.a, [row.id])).values();
    assertEquals([totals.likes, totals.shares, totals.replies], [4, null, null]);
});

Deno.test("a total that isn't one is given up on, and one too large is cut", async () => {
    await using invalid = await open({ likes: -1, shares: 1, replies: 1 });
    const row = await invalid.send();

    assertEquals(await totalsOf(invalid.a, [row.id]), new Map());
    assertEquals(await invalid.counts(), [0, 0, 0]);

    await using large = await open({ likes: 10 ** 15, shares: "2", replies: 1 });
    await large.send();
    assertEquals(large.asked(), 2);

    await using cut = await open({ likes: 10 ** 15, shares: 1, replies: 1 });
    await cut.send();
    assertEquals(await cut.counts(), [2 ** 31 - 1, 1, 1]);
});

Deno.test("only another instance's note that is still there, and not blocked, has its totals fetched", async () => {
    await using test = await open({ likes: 1, shares: 1, replies: 1 });
    const local = await createNote(test.a, test.alice);
    await fetchTotalsLater(test.a, local);
    assertEquals(
        await test.a.db.selectFrom("jobs").select("id").where("queue", "=", totalsQueue).execute(),
        [],
    );

    const row = await test.send();
    const from = test.asked();
    await blockDomain(test.a, "b.test");
    await test.a.db.deleteFrom("remote_note_totals").execute();
    await fetchTotalsLater(test.a, row);
    await test.network.drain();

    assertEquals(test.asked(), from);
    assertEquals(await totalsOf(test.a, [row.id]), new Map());

    await using gone = await open({ likes: 1, shares: 1, replies: 1 });
    const deleted = await gone.send();
    const before = gone.asked();
    await fetchTotalsLater(gone.a, deleted);
    await gone.a.db.deleteFrom("notes").where("id", "=", deleted.id).execute();
    await gone.network.drain();
    assertEquals(gone.asked(), before);
});

Deno.test("a Verso instance gives its notes' totals to another", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const carol = await createLocalAccount(a, "carol");
    const bob = await createLocalAccount(b, "bob");
    const aliceOnB = await b.federation.resolve(b, { host: "a.test", id: alice }, "User");
    assertExists(aliceOnB);
    await follow(b, bob, aliceOnB);
    await network.drain();

    const posted = await createNote(a, alice);
    await like(a, carol, posted.id);
    await createNote(a, carol, {
        in_reply_to_id: posted.id,
        in_reply_to_account_id: alice,
    });
    const received = await b.federation.resolve(b, { host: "a.test", id: posted.id }, "Note");
    assertExists(received);
    await network.drain();

    const [totals] = (await totalsOf(b, [received])).values();
    assertEquals([totals.likes, totals.shares, totals.replies], [1, 0, 1]);
});
