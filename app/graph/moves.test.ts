import { assert, assertEquals, assertExists } from "@std/assert";
import type { AccountMoved } from "../accounts/events.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { createList } from "../lists/lists.ts";
import { insertListAccount, listAccountsAmong } from "../lists/list_queries.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { accountNoteLimit } from "./account_notes.ts";
import { accountNotesOn, setAccountNote } from "./account_note_queries.ts";
import { insertBlock } from "./block_queries.ts";
import { blockDomainFor } from "./domain_blocks.ts";
import { acceptFollow, follow } from "./follows.ts";
import { followsFrom, insertFollow } from "./follow_queries.ts";
import { moveHandler, moveQueue, queueMoves } from "./moves.ts";
import { mutesOf, upsertMute } from "./mute_queries.ts";

/** A user `id`, with `previous` as the account it says it moved from, if any. */
const user = (id: string, previous?: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
    ...(previous === undefined ? {} : { extensions: { "pub.versia:migration": { previous } } }),
});

/**
 * a.test, with alice, bea and cid, and b.test and c.test, which send whatever they are told to.
 * b.test has bob, whom a.test has, and c.test has bob2, which says it moved from bob.
 */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const c = await addEvilInstance(network, "c.test", ["pub.versia:migration"]);
    const path = (id: string) => `/.versia/v0.6/entities/User/${id}`;
    b.serve(path("bob"), user("bob"));
    c.serve(path("bob2"), user("bob2", "b.test:bob"));
    c.serve(path("carol"), user("carol"));

    const alice = await createLocalAccount(a, "alice");
    const bea = await createLocalAccount(a, "bea");
    const cid = await createLocalAccount(a, "cid");
    const resolve = async (host: string, id: string) => {
        const found = await a.federation.resolve(a, { host, id }, "User");
        assertExists(found);
        return found;
    };
    const bob = await resolve("b.test", "bob");
    const bob2 = await resolve("c.test", "bob2");
    const carol = await resolve("c.test", "carol");

    /** Has b.test say bob moved to bob2, and a.test do what follows. */
    const migrate = async () => {
        const response = await b.send("https://a.test/.versia/v0.6/inbox", {
            body: {
                type: "pub.versia:migration/Migration",
                created_at: network.clock.now().toISOString(),
                author: "b.test:bob",
                destination: "c.test:bob2",
            },
        });
        assertEquals(response.status, 202);
        await network.drain();
    };

    /** Has `id` follow bob, and bob accept. */
    const followBob = async (id: string, options = {}) => {
        assertEquals(await follow(a, id, bob, options), "requested");
        assertEquals(await acceptFollow(a, id, bob), true);
    };

    /** Who `id` follows, of bob and bob2, as whether each was accepted. */
    const following = async (id: string) =>
        Object.fromEntries(
            (await followsFrom(a, id, [bob, bob2])).map((row) => [
                row.followee_id === bob ? "bob" : "bob2",
                row.accepted,
            ]),
        );

    /** The follows and unfollows a.test sent for `username`, as their host, type and followee. */
    const sentBy = async (username: string) => {
        const sent = [];
        for (const request of network.transport.sent) {
            if (request.method !== "POST" || request.url.startsWith("https://a.test/")) continue;

            const body = await request.clone().json();
            if (body.author === username) {
                sent.push([new URL(request.url).host, body.type, body.followee]);
            }
        }

        return sent;
    };

    return {
        network,
        a,
        alice,
        bea,
        cid,
        bob,
        bob2,
        carol,
        migrate,
        followBob,
        following,
        sentBy,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("local followers of a user that moved follow the account it moved to instead", async () => {
    await using test = await open();
    await test.followBob(test.alice, { showReblogs: false, notify: true, languages: ["de"] });
    await test.followBob(test.bea);
    const list = await createList(test.a, test.alice, {
        title: "Friends",
        replies_policy: "list",
        exclusive: false,
    });
    assert(list !== "full");
    const [old] = await followsFrom(test.a, test.alice, [test.bob]);
    await insertListAccount(test.a, list.id, { accountId: test.bob, followId: old.id });
    await insertListAccount(test.a, list.id, { accountId: test.bob2, followId: null });
    // A list of another follow's, which bob2 isn't put in.
    const other = await createList(test.a, test.alice, {
        title: "Others",
        replies_policy: "list",
        exclusive: false,
    });
    assert(other !== "full");
    assertEquals(await follow(test.a, test.alice, test.cid), "following");
    const [cid] = await followsFrom(test.a, test.alice, [test.cid]);
    await insertListAccount(test.a, other.id, { accountId: test.cid, followId: cid.id });
    // A remote follower, which a.test doesn't move.
    await insertFollow(test.a, {
        followerId: test.carol,
        followeeId: test.bob,
        accepted: true,
        options: {},
    });
    // cid only asked to follow bob, so doesn't follow bob2.
    assertEquals(await follow(test.a, test.cid, test.bob), "requested");

    await test.migrate();
    for (const id of [test.alice, test.bea]) {
        assertEquals(await test.following(id), { bob2: false });
    }
    assertEquals(await test.following(test.cid), { bob: false });
    assertEquals(await test.following(test.carol), { bob: true });
    assertEquals((await listAccountsAmong(test.a, other.id, [test.bob2])).size, 0);
    const [moved] = await followsFrom(test.a, test.alice, [test.bob2]);
    assertEquals(
        [moved.show_reblogs, moved.notify, moved.languages],
        [false, true, ["de"]],
    );
    assertEquals([...await listAccountsAmong(test.a, list.id, [test.bob, test.bob2])], [
        test.bob2,
    ]);
    assertEquals(await test.sentBy("alice"), [
        ["b.test", "Follow", "b.test:bob"],
        ["c.test", "Follow", "c.test:bob2"],
        ["b.test", "Unfollow", "b.test:bob"],
    ]);
});

Deno.test("a follower that blocks the account moved to, or can't follow it, keeps following", async () => {
    await using test = await open();
    await test.followBob(test.alice);
    await test.followBob(test.bea);
    await test.followBob(test.cid);
    await insertBlock(test.a, test.alice, test.bob2);
    await blockDomainFor(test.a, test.bea, "c.test");
    // The job moves no one it couldn't before, and ends.
    await test.a.db.updateTable("accounts").set({ suspended_at: test.network.clock.now() })
        .where("id", "=", test.bob2).execute();
    await moveHandler(test.a, {
        payload: { step: "follows", accountId: test.bob, movedToId: test.bob2 },
    } as never);
    assertEquals(await test.following(test.cid), { bob: true });
    await test.a.db.updateTable("accounts").set({ suspended_at: null })
        .where("id", "=", test.bob2).execute();

    await test.migrate();
    assertEquals(await test.following(test.alice), { bob: true });
    assertEquals(await test.following(test.bea), { bob: true });
    assertEquals(await test.following(test.cid), { bob2: false });
});

Deno.test("blocks and mutes of a user that moved carry over, with a note", async () => {
    await using test = await open();
    const { a, alice, bea, cid, bob, bob2 } = test;
    await insertBlock(a, alice, bob);
    await upsertMute(a, bea, bob, { notifications: false, expiresAt: new Date(2100, 0) });
    await upsertMute(a, cid, bob, { notifications: true, expiresAt: null });
    await setAccountNote(a, cid, bob2, "Already noted");
    // A mute that ended isn't carried over.
    const ended = new Date(test.network.clock.now().getTime() - 1);
    await upsertMute(a, alice, bob, { notifications: true, expiresAt: ended });

    await test.migrate();
    const blocks = await a.db.selectFrom("blocks").select("account_id")
        .where("target_id", "=", bob2).execute();
    assertEquals(blocks.map((row) => row.account_id), [alice]);
    const muted = await mutesOf(a, bea, [bob2]);
    assertEquals(
        [muted.get(bob2)?.notifications, muted.get(bob2)?.expires_at],
        [false, null],
    );
    assertEquals((await mutesOf(a, cid, [bob2])).get(bob2)?.notifications, true);
    assertEquals((await mutesOf(a, alice, [bob2])).size, 0);
    assertEquals([...(await accountNotesOn(a, alice, [bob2])).values()], [
        "This user moved from bob@b.test, which you had blocked.",
    ]);
    assertEquals([...(await accountNotesOn(a, bea, [bob2])).values()], [
        "This user moved from bob@b.test, which you had muted.",
    ]);
    assertEquals([...(await accountNotesOn(a, cid, [bob2])).values()], ["Already noted"]);
});

Deno.test("a block or mute isn't carried over by one following either account, or muting it", async () => {
    await using test = await open();
    const { a, alice, bea, cid, bob, bob2 } = test;
    await insertBlock(a, alice, bob);
    await test.followBob(alice);
    await upsertMute(a, bea, bob, { notifications: true, expiresAt: null });
    assertEquals(await follow(a, bea, bob2), "requested");
    await upsertMute(a, cid, bob, { notifications: true, expiresAt: null });
    await upsertMute(a, cid, bob2, { notifications: false, expiresAt: null });

    await test.migrate();
    const blocks = await a.db.selectFrom("blocks").select("account_id")
        .where("target_id", "=", bob2).execute();
    assertEquals(blocks, []);
    assertEquals((await mutesOf(a, bea, [bob2])).size, 0);
    assertEquals((await mutesOf(a, cid, [bob2])).get(bob2)?.notifications, false);
    for (const id of [alice, bea, cid]) {
        assertEquals((await accountNotesOn(a, id, [bob2])).size, 0);
    }
});

Deno.test("notes on a user that moved are copied to the account it moved to, once", async () => {
    await using test = await open();
    const { a, alice, bea, cid, bob, bob2 } = test;
    const text = "This user moved from bob@b.test, here were your previous notes about them:";
    await setAccountNote(a, alice, bob, "Old");
    await setAccountNote(a, bea, bob, "Old");
    await setAccountNote(a, bea, bob2, "New");
    await setAccountNote(a, cid, bob, "x".repeat(2000));
    await insertBlock(a, alice, bob);
    // Just short enough to be copied whole.
    const dan = await createLocalAccount(a, "dan");
    const longest = "y".repeat(accountNoteLimit - text.length - 1);
    await setAccountNote(a, dan, bob, longest);

    await test.migrate();
    const notes = async () =>
        await Promise.all(
            [alice, bea, cid, dan].map(async (id) =>
                (await accountNotesOn(a, id, [bob2])).get(bob2)
            ),
        );
    assertEquals(await notes(), [
        `${text}\nOld`,
        `${text}\nOld\n\n\nNew`,
        "x".repeat(2000),
        `${text}\n${longest}`,
    ]);

    // Done again, as a job tried again would, it changes nothing.
    await moveHandler(a, {
        payload: { step: "relationships", accountId: bob, movedToId: bob2 },
    } as never);
    assertEquals(await notes(), [
        `${text}\nOld`,
        `${text}\nOld\n\n\nNew`,
        "x".repeat(2000),
        `${text}\n${longest}`,
    ]);
});

Deno.test("a move is queued once for each account moved to", async () => {
    await using test = await open();
    const jobs = async () =>
        (await test.a.db.selectFrom("jobs").select("payload").where("queue", "=", moveQueue)
            .execute()).length;
    const queue = (movedToId: string) => {
        const moved: AccountMoved = { type: "accounts.moved", accountId: test.bob, movedToId };
        return queueMoves(test.a, moved);
    };

    await queue(test.bob2);
    await queue(test.bob2);
    assertEquals(await jobs(), 2);

    await queue(test.carol);
    assertEquals(await jobs(), 4);
});
