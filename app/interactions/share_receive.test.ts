import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { findNote, findRemoteNoteAt } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findLike } from "./like_queries.ts";

/** A user b.test serves. */
const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** A public note by carol. */
const note = (id: string) => ({
    type: "Note",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "carol",
    content: { "text/plain": { content: "Hi", remote: false } },
    group: "public",
    is_sensitive: false,
    mentions: [],
    attachments: [],
    previews: [],
});

/** bob's Share of the note `shared`. */
const sharing = (id: string, shared: string, created_at = "2026-01-01T00:00:00Z") => ({
    type: "pub.versia:share/Share",
    id,
    created_at,
    author: "bob",
    shared,
});

/** bob's Delete of his share, or of a note, `id`. */
const undo = (id: string, deleted_type = "pub.versia:share/Share") => ({
    type: "Delete",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    deleted_type,
    deleted: id,
});

/** a.test, with alice and her note, and b.test, which sends what it is told, with bob and carol. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    for (const id of ["bob", "carol"]) b.serve(`/.versia/v0.6/entities/User/${id}`, user(id));

    const alice = await createLocalAccount(a, "alice");
    const local = await createNote(a, alice);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test take it in. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** Has alice follow bob, and b.test accept it. */
    const followBob = async () => {
        const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
        assertExists(bob);
        await follow(a, alice, bob);
        await send({
            type: "FollowAccept",
            author: "bob",
            follower: `a.test:${alice}`,
            created_at: "2026-01-01T00:00:00Z",
        });
    };

    /** What b.test has as `remoteId`, as a.test keeps it, if it does. */
    const kept = (remoteId: string) => findRemoteNoteAt(a, "b.test", remoteId);

    /** bob's statuses, and the shares of the note with `noteId`. */
    const counts = async (noteId: string) => {
        const bob = await a.db.selectFrom("accounts").select("id").where("remote_id", "=", "bob")
            .executeTakeFirst();
        return [
            bob && (await findAccount(a, bob.id))?.statuses_count,
            (await findNote(a, noteId))?.shares_count,
        ];
    };

    /** Why a.test gave up on what it was sent, oldest first. */
    const errors = async () =>
        (await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
            .where("last_error", "is not", null).orderBy("created_at").execute())
            .map((job) => job.last_error ?? "");

    return {
        network,
        a,
        b,
        alice,
        local,
        send,
        followBob,
        kept,
        counts,
        errors,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a share of a local note is kept and counted, once, and a Delete undoes it", async () => {
    await using test = await open();
    const shared = `a.test:${test.local.id}`;

    await test.send(sharing("s1", shared));
    const share = await test.kept("s1");
    assertEquals(
        [share?.reblog_of_id, share?.visibility, share?.created_at.toISOString()],
        [test.local.id, "public", "2026-01-01T00:00:00.000Z"],
    );
    assertEquals(await test.counts(test.local.id), [1, 1]);

    // Sent again, it is the same share. It is sent with another date, so it isn't taken for the
    // same delivery.
    await test.send(sharing("s1", shared, "2026-01-02T00:00:00Z"));
    assertEquals((await test.kept("s1"))?.id, share?.id);
    assertEquals(await test.counts(test.local.id), [1, 1]);

    // A note's Delete doesn't delete a share.
    await test.send(undo("s1", "Note"));
    assertEquals((await test.kept("s1"))?.id, share?.id);

    await test.send(undo("s1"));
    assertEquals(await test.kept("s1"), undefined);
    assertEquals(await test.counts(test.local.id), [0, 0]);
    assertEquals(await test.errors(), []);
});

Deno.test("another share of a note by the same user replaces the first", async () => {
    await using test = await open();
    const shared = `a.test:${test.local.id}`;

    await test.send(sharing("s1", shared));
    await test.send(sharing("s2", shared));

    assertEquals(await test.kept("s1"), undefined);
    assertEquals((await test.kept("s2"))?.reblog_of_id, test.local.id);
    assertEquals(await test.counts(test.local.id), [1, 1]);

    // The share it replaced is gone already.
    await test.send(undo("s1"));
    assertExists(await test.kept("s2"));
    assertEquals(await test.errors(), []);
});

Deno.test("a share of another note by someone a local user follows is kept, with the note", async () => {
    await using test = await open();
    test.b.serve("/.versia/v0.6/entities/Note/n1", note("n1"));

    // a.test has bob, but no one here follows him yet, so neither the share nor its note is kept.
    await test.a.federation.resolve(test.a, { host: "b.test", id: "bob" }, "User");
    await test.send(sharing("s1", "n1"));
    assertEquals([await test.kept("s1"), await test.kept("n1")], [undefined, undefined]);

    await test.followBob();
    await test.send(sharing("s2", "n1"));
    const original = await test.kept("n1");
    assertExists(original);
    const share = await test.kept("s2");
    assertEquals([share?.reblog_of_id, share?.visibility], [original.id, "public"]);
    assertEquals(await test.errors(), []);
});

Deno.test("a share of a note that can't be shared, or by an unknown sharer, is refused", async () => {
    await using test = await open();
    const hidden = await createNote(test.a, test.alice, { visibility: "private" });

    await test.send(sharing("s1", `a.test:${hidden.id}`));
    await test.send(sharing("s2", "a.test:missing"));

    assertEquals([await test.kept("s1"), await test.kept("s2")], [undefined, undefined]);
    const [unshareable, missing] = await test.errors();
    assertStringIncludes(unshareable ?? "", `a.test:${hidden.id} can't be shared`);
    assertStringIncludes(missing ?? "", "Verso doesn't have a.test:missing");
});

Deno.test("a share isn't taken for a note, nor a note for a share", async () => {
    await using test = await open();
    await test.followBob();
    await test.send(sharing("s1", `a.test:${test.local.id}`));
    await test.send({ ...note("n1"), author: "bob" });

    // A note, or a like, naming the share's id doesn't find it.
    await test.send({ ...note("s1"), author: "bob" });
    await test.send({
        type: "pub.versia:likes/Like",
        id: "l1",
        created_at: "2026-01-01T00:00:00Z",
        author: "bob",
        liked: "s1",
    });
    await test.send(sharing("n1", `a.test:${test.local.id}`, "2026-01-02T00:00:00Z"));
    await test.send(undo("n1"));

    const share = await test.kept("s1");
    assertEquals([share?.reblog_of_id, share?.content], [test.local.id, ""]);
    assertEquals((await test.kept("n1"))?.reblog_of_id, null);
    assertEquals(await findLike(test.a, share?.account_id ?? "", share?.id ?? ""), undefined);
    const [asNote, asShare] = await test.errors();
    assertStringIncludes(asNote ?? "", "s1 on b.test is a Share, not a Note");
    assertStringIncludes(asShare ?? "", "n1 is a Note, not a Share");
});
