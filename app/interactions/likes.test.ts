import { assertEquals } from "@std/assert";
import { deleteRemoteAccount } from "../accounts/remote.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block, blockedSubquery } from "../graph/blocks.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { countLikesBy, findLike, likedAmong } from "./like_queries.ts";
import { keepRemoteLike, like, unlike } from "./likes.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    const likesOf = async (noteId: string) => (await findNote(test.ctx, noteId))?.likes_count;
    return { ...test, likesOf };
};

Deno.test("a note is liked once, and counted once, however often it is liked", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    assertEquals((await like(test.ctx, "bob", note.id))?.likes_count, 1);
    assertEquals((await like(test.ctx, "bob", note.id))?.likes_count, 1);
    assertEquals((await like(test.ctx, "dave", note.id))?.likes_count, 2);
    assertEquals(await likedAmong(test.ctx, "bob", [note.id, "other"]), new Set([note.id]));

    assertEquals((await unlike(test.ctx, "bob", note.id))?.likes_count, 1);
    assertEquals((await unlike(test.ctx, "bob", note.id))?.likes_count, 1);
    assertEquals(await findLike(test.ctx, "bob", note.id), undefined);
    assertEquals(await likedAmong(test.ctx, "bob", [note.id]), new Set());
});

Deno.test("only a note the liker may see can be liked", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals(await like(test.ctx, "dave", note.id), undefined);
    assertEquals(await like(test.ctx, "bob", "missing"), undefined);
    assertEquals(await test.likesOf(note.id), 0);

    assertEquals((await like(test.ctx, "bob", note.id))?.likes_count, 1);
});

Deno.test("a like can be undone after its note can't be seen, but no one else's", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });
    await like(test.ctx, "bob", note.id);
    await unfollow(test.ctx, "bob", "alice");

    assertEquals(await unlike(test.ctx, "dave", note.id), undefined);
    assertEquals((await unlike(test.ctx, "bob", note.id))?.likes_count, 0);
    assertEquals(await unlike(test.ctx, "bob", note.id), undefined);
});

Deno.test("a remote account deleted is uncounted from the notes it liked", async () => {
    await using test = await open();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    const liked = await createNote(test.ctx, "alice");
    const other = await createNote(test.ctx, "alice");
    for (const by of ["carol", "bob"]) await like(test.ctx, by, liked.id);
    await like(test.ctx, "bob", other.id);
    await keepRemoteLike(test.ctx, {
        accountId: "carol",
        noteId: other.id,
        kind: "dislike",
        instanceId: "b.example",
        remoteId: "d1",
        createdAt: test.ctx.clock.now(),
    });

    await deleteRemoteAccount(test.ctx, "b.example", "carol");

    assertEquals([await test.likesOf(liked.id), await test.likesOf(other.id)], [1, 1]);
});

Deno.test("the likes the accounts someone blocks make are counted by note, without dislikes", async () => {
    await using test = await open();
    const [first, second, other] = [
        await createNote(test.ctx, "alice"),
        await createNote(test.ctx, "alice"),
        await createNote(test.ctx, "alice"),
    ];
    for (const note of [first, other]) await like(test.ctx, "dave", note.id);
    await like(test.ctx, "bob", first.id);
    await test.ctx.db.insertInto("likes").values({
        id: test.ctx.ids(),
        account_id: "dave",
        note_id: second.id,
        kind: "dislike",
        instance_id: null,
        remote_id: null,
        created_at: test.clock.now(),
    }).execute();
    await block(test.ctx, "alice", "dave");

    assertEquals(
        await countLikesBy(test.ctx, [first.id, second.id], blockedSubquery(test.ctx, "alice")),
        new Map([[first.id, 1]]),
    );
    assertEquals(await countLikesBy(test.ctx, [], blockedSubquery(test.ctx, "alice")), new Map());
});
