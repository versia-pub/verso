import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findLike, likePage } from "./like_queries.ts";
import { like } from "./likes.ts";

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

/** bob's Like, or Dislike, of the note `note`. */
const liking = (kind: "Like" | "Dislike", id: string, note: string, author = "bob") => ({
    type: `pub.versia:likes/${kind}`,
    id,
    created_at: "2026-01-01T00:00:00Z",
    author,
    [kind === "Like" ? "liked" : "disliked"]: note,
});

/** bob's Delete of his like or dislike `id`. */
const undo = (kind: "Like" | "Dislike", id: string) => ({
    type: "Delete",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    deleted_type: `pub.versia:likes/${kind}`,
    deleted: id,
});

/** a.test, with alice and her note, and b.test, which sends what it is told, with bob. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", user("bob"));

    const alice = await createLocalAccount(a, "alice");
    const note = await createNote(a, alice);

    /** Has b.test send `entity` to a.test, and a.test take it in. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** bob, as a.test has him, if it does. */
    const bob = async () =>
        (await a.db.selectFrom("accounts").select("id").where("remote_id", "=", "bob")
            .executeTakeFirst())?.id;

    /** bob's like or dislike of alice's note, and how many likes it has. */
    const state = async () => {
        const id = await bob();
        const row = id === undefined ? undefined : await findLike(a, id, note.id);
        return [row?.kind, row?.remote_id, (await findNote(a, note.id))?.likes_count];
    };

    /** Why a.test gave up on what it was sent, oldest first. */
    const errors = async () =>
        (await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
            .where("last_error", "is not", null).orderBy("created_at").execute())
            .map((job) => job.last_error ?? "");

    return {
        network,
        a,
        alice,
        note,
        send,
        bob,
        state,
        errors,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a like of a local note is kept and counted, and a Delete undoes it", async () => {
    await using test = await open();

    await test.send(liking("Like", "l1", `a.test:${test.note.id}`));
    assertEquals(await test.state(), ["like", "l1", 1]);
    const [first] = await likePage(test.a, { noteId: test.note.id, blocked: null }, { limit: 40 });

    // Sent again, it is the same like, where it was among the note's likes. It is sent with
    // another date, so it isn't taken for the same delivery.
    await test.send({
        ...liking("Like", "l1", `a.test:${test.note.id}`),
        created_at: "2026-01-02T00:00:00Z",
    });
    assertEquals(await test.state(), ["like", "l1", 1]);
    assertEquals(await likePage(test.a, { noteId: test.note.id, blocked: null }, { limit: 40 }), [
        first,
    ]);

    await test.send(undo("Like", "l1"));
    assertEquals(await test.state(), [undefined, undefined, 0]);
    assertEquals(await test.errors(), []);
});

Deno.test("a dislike replaces a like, and a like a dislike, and only likes count", async () => {
    await using test = await open();
    const liked = `a.test:${test.note.id}`;

    await test.send(liking("Like", "l1", liked));
    await test.send(liking("Dislike", "d1", liked));
    assertEquals(await test.state(), ["dislike", "d1", 0]);
    assertEquals(
        await likePage(test.a, { noteId: test.note.id, blocked: null }, { limit: 40 }),
        [],
    );

    // The like it replaced is gone already.
    await test.send(undo("Like", "l1"));
    assertEquals(await test.state(), ["dislike", "d1", 0]);

    await test.send(liking("Like", "l2", liked));
    assertEquals(await test.state(), ["like", "l2", 1]);

    await test.send(liking("Dislike", "d2", liked));
    await test.send(undo("Dislike", "d2"));
    assertEquals(await test.state(), [undefined, undefined, 0]);
});

Deno.test("a like of a note Verso doesn't have is dropped, without fetching its author", async () => {
    await using test = await open();

    await test.send(liking("Like", "l1", "b.test:elsewhere"));
    await test.send(liking("Like", "l2", "a.test:missing"));

    assertEquals(await test.bob(), undefined);
    assertEquals(await test.errors(), []);
});

Deno.test("a like of a local note its author may not see is refused", async () => {
    await using test = await open();
    const hidden = await createNote(test.a, test.alice, { visibility: "private" });

    await test.send(liking("Like", "l1", `a.test:${hidden.id}`));

    assertEquals((await findNote(test.a, hidden.id))?.likes_count, 0);
    const [error] = await test.errors();
    assertStringIncludes(error ?? "", `may not see a.test:${hidden.id}`);
});

Deno.test("only the instance a like came from may undo it", async () => {
    await using test = await open();
    await test.send(liking("Like", "l1", `a.test:${test.note.id}`));
    const carol = await createLocalAccount(test.a, "carol");
    await like(test.a, carol, test.note.id);
    const local = await findLike(test.a, carol, test.note.id);
    assertExists(local);

    // b.test can't name another instance's like, and a.test's own has no id there.
    await test.send(undo("Like", local.id));

    assertEquals((await findNote(test.a, test.note.id))?.likes_count, 2);
});
