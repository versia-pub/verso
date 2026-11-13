import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { findLike, likePage } from "./like_queries.ts";
import { like } from "./likes.ts";
import { openFederation, undo } from "./testing.ts";

/** The type of a Like or Dislike. */
const likeType = (kind: "Like" | "Dislike") => `pub.versia:likes/${kind}`;

/** bob's Like, or Dislike, of the status `note`. */
const liking = (kind: "Like" | "Dislike", id: string, note: string, author = "bob") => ({
    type: likeType(kind),
    id,
    created_at: "2026-01-01T00:00:00Z",
    author,
    [kind === "Like" ? "liked" : "disliked"]: note,
});

/** a.test, with alice and her status, and b.test, which serves bob. */
const open = async () => {
    const test = await openFederation(["bob"]);
    const { a, local } = test;

    /** bob, as a.test has him, if it does. */
    const bob = async () =>
        (await a.db.selectFrom("accounts").select("id").where("remote_id", "=", "bob")
            .executeTakeFirst())?.id;

    /** bob's like or dislike of alice's status, and how many likes it has. */
    const state = async () => {
        const id = await bob();
        const row = id === undefined ? undefined : await findLike(a, id, local.id);
        return [row?.kind, row?.remote_id, (await findNote(a, local.id))?.likes_count];
    };

    return { ...test, bob, state };
};

Deno.test("a like of a local note is kept and counted, and a Delete undoes it", async () => {
    await using test = await open();

    await test.send(liking("Like", "l1", `a.test:${test.local.id}`));
    assertEquals(await test.state(), ["like", "l1", 1]);
    const [first] = await likePage(test.a, { noteId: test.local.id, blocked: null }, { limit: 40 });

    // Sent again, it is the same like, in the same position among the status's likes. It is sent
    // with a different date, so it isn't mistaken for the same delivery.
    await test.send({
        ...liking("Like", "l1", `a.test:${test.local.id}`),
        created_at: "2026-01-02T00:00:00Z",
    });
    assertEquals(await test.state(), ["like", "l1", 1]);
    assertEquals(await likePage(test.a, { noteId: test.local.id, blocked: null }, { limit: 40 }), [
        first,
    ]);

    await test.send(undo(likeType("Like"), "l1"));
    assertEquals(await test.state(), [undefined, undefined, 0]);
    assertEquals(await test.errors(), []);
});

Deno.test("a dislike replaces a like, and a like a dislike, and only likes count", async () => {
    await using test = await open();
    const liked = `a.test:${test.local.id}`;

    await test.send(liking("Like", "l1", liked));
    await test.send(liking("Dislike", "d1", liked));
    assertEquals(await test.state(), ["dislike", "d1", 0]);
    assertEquals(
        await likePage(test.a, { noteId: test.local.id, blocked: null }, { limit: 40 }),
        [],
    );

    // The like it replaced is already gone.
    await test.send(undo(likeType("Like"), "l1"));
    assertEquals(await test.state(), ["dislike", "d1", 0]);

    await test.send(liking("Like", "l2", liked));
    assertEquals(await test.state(), ["like", "l2", 1]);

    await test.send(liking("Dislike", "d2", liked));
    await test.send(undo(likeType("Dislike"), "d2"));
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
    await test.send(liking("Like", "l1", `a.test:${test.local.id}`));
    const carol = await createLocalAccount(test.a, "carol");
    await like(test.a, carol, test.local.id);
    const local = await findLike(test.a, carol, test.local.id);
    assertExists(local);

    // b.test can't name a like from another instance, and a.test's own like has no id there.
    await test.send(undo(likeType("Like"), local.id));

    assertEquals((await findNote(test.a, test.local.id))?.likes_count, 2);
});
