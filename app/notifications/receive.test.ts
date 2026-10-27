import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { acceptFollow, follow } from "../graph/follows.ts";
import { share } from "../interactions/shares.ts";
import { findRemoteNoteAt } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { notificationsOf } from "./testing.ts";

/** A user served by b.test. */
const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** A public status by bob saying `text`, unless `fields` says otherwise. */
const note = (id: string, text: string, fields: Record<string, unknown> = {}) => ({
    type: "Note",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    content: { "text/plain": { content: text, remote: false } },
    group: "public",
    is_sensitive: false,
    mentions: [],
    attachments: [],
    previews: [],
    ...fields,
});

/** bob's like, boost or reaction, of the type `type`. */
const interaction = (type: string, id: string, fields: Record<string, unknown>) => ({
    type,
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    ...fields,
});

/** bob's Delete of his `type` `id`. */
const undo = (type: string, id: string) => ({
    type: "Delete",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    deleted_type: type,
    deleted: id,
});

const like = "pub.versia:likes/Like";
const dislike = "pub.versia:likes/Dislike";
const shared = "pub.versia:share/Share";
const reaction = "pub.versia:reactions/Reaction";

/**
 * a.test, with alice and her status, and carol, who follows bob with notifications on, and b.test,
 * which sends whatever it is told to, with bob.
 */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", user("bob"));

    const alice = await createLocalAccount(a, "alice");
    const carol = await createLocalAccount(a, "carol");
    const local = await createNote(a, alice);
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);
    await follow(a, carol, bob, { notify: true });
    await acceptFollow(a, carol, bob);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test receive it. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** The id a.test gives bob's status `id`. */
    const kept = async (id: string) => {
        const row = await findRemoteNoteAt(a, "b.test", id);
        assertExists(row);
        return row.id;
    };

    return {
        a,
        b,
        alice,
        carol,
        bob,
        local,
        send,
        kept,
        of: (id: string) => notificationsOf(a, id),
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("remote likes, boosts and reactions notify, until they are deleted", async () => {
    await using test = await open();
    const other = await createNote(test.a, test.alice);
    const object = `a.test:${test.local.id}`;

    await test.send(interaction(like, "l1", { liked: object }));
    await test.send(interaction(like, "l1", { liked: object }));
    await test.send(interaction(dislike, "d1", { disliked: `a.test:${other.id}` }));
    await test.send(interaction(shared, "s1", { shared: object }));
    await test.send(interaction(reaction, "r1", { object, content: "🎉" }));
    await test.send(interaction(reaction, "r1", { object, content: "🎉" }));
    assertEquals(await test.of(test.alice), [
        `reaction ${test.bob} ${test.local.id}`,
        `reblog ${test.bob} ${test.local.id}`,
        `favourite ${test.bob} ${test.local.id}`,
    ]);

    await test.send(undo(like, "l1"));
    await test.send(undo(shared, "s1"));
    await test.send(undo(reaction, "r1"));
    assertEquals(await test.of(test.alice), []);
});

Deno.test("remote statuses notify those they mention, and followers who asked", async () => {
    await using test = await open();

    await test.send(note("n1", "Hi @alice", { mentions: [`a.test:${test.alice}`] }));
    const n1 = await test.kept("n1");
    assertEquals(await test.of(test.alice), [`mention ${test.bob} ${n1}`]);
    assertEquals(await test.of(test.carol), [`status ${test.bob} ${n1}`]);

    await test.send(undo("Note", "n1"));
    assertEquals(await test.of(test.alice), []);
    assertEquals(await test.of(test.carol), []);
});

Deno.test("remote statuses Verso fetched notify no one", async () => {
    await using test = await open();
    test.b.serve(
        "/.versia/v0.6/entities/Note/n0",
        note("n0", "Hi @alice", { mentions: [`a.test:${test.alice}`] }),
    );

    await test.send(note("n1", "And more", { replies_to: "n0" }));
    assertEquals(await test.of(test.alice), []);
    assertEquals(await test.of(test.carol), [`status ${test.bob} ${await test.kept("n1")}`]);
});

Deno.test("remote edits notify local users who boosted it, and those it newly mentions", async () => {
    await using test = await open();
    await test.send(note("n1", "Hi"));
    const n1 = await test.kept("n1");
    await share(test.a, test.carol, n1);

    await test.send(note("n1", "Hi"));
    assertEquals(await test.of(test.carol), [`status ${test.bob} ${n1}`]);

    await test.send(note("n1", "Hi @alice", { mentions: [`a.test:${test.alice}`] }));
    assertEquals(await test.of(test.carol), [
        `update ${test.bob} ${n1}`,
        `status ${test.bob} ${n1}`,
    ]);
    assertEquals(await test.of(test.alice), [`mention ${test.bob} ${n1}`]);
});
