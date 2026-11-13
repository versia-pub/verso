import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { keepRemoteEmojis } from "../emojis/emojis.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { block, blockedByAccount } from "../graph/blocks.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { renderStatuses } from "../notes/render.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { reactionsOf } from "./reaction_render_queries.ts";
import { react, reactionEmoji, unreact } from "./reactions.ts";

/** alice, bob, who follows her, and dave; the local instance's blob, and b.example's dog. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");
    await createLocalEmoji(test.ctx, "blob");
    await createInstance(test.ctx, "b.example");
    const [dog] = await keepRemoteEmojis(test.ctx, "b.example", [{
        shortcode: "dog",
        picture: { url: "https://b.example/dog.png", mediaType: "image/png" },
    }]);

    /** How many reactions a status has, of any emoji. */
    const total = async (noteId: string) =>
        ((await reactionsOf(test.ctx, [noteId], null, null)).get(noteId) ?? [])
            .reduce((sum, group) => sum + group.count, 0);

    return { ...test, dog, total };
};

Deno.test("a note is reacted to with each emoji once, the first used first", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    for (const [by, name] of [["bob", "👍🏽"], ["dave", "blob"], ["bob", "blob"]]) {
        assertEquals((await react(test.ctx, by, note.id, name)) !== "missing", true);
    }

    // Again, it is the same reaction.
    await react(test.ctx, "bob", note.id, "blob");

    assertEquals(await test.total(note.id), 3);
    const groups = (await reactionsOf(test.ctx, [note.id], "bob", null)).get(note.id) ?? [];
    assertEquals(groups.map((group) => [group.text, group.shortcode, group.count, group.me]), [
        ["👍🏽", null, 1, true],
        [null, "blob", 2, true],
    ]);
    assertEquals(
        ((await reactionsOf(test.ctx, [note.id], "dave", null)).get(note.id) ?? [])
            .map((group) => group.me),
        [false, true],
    );
});

Deno.test("the reactions of blocked accounts are taken from their status's and emoji's count", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "cat");
    const notes = [await createNote(test.ctx, "alice"), await createNote(test.ctx, "alice")];
    await react(test.ctx, "dave", notes[0].id, "blob");
    for (const note of notes) {
        for (const name of ["blob", "cat"]) await react(test.ctx, "bob", note.id, name);
    }
    await block(test.ctx, "alice", "dave");

    const ids = notes.map((note) => note.id);
    const groups = await reactionsOf(test.ctx, ids, "alice", blockedByAccount(test.ctx, "alice"));
    assertEquals(
        ids.map((id) => (groups.get(id) ?? []).map((group) => [group.shortcode, group.count])),
        [[["blob", 1], ["cat", 1]], [["blob", 1], ["cat", 1]]],
    );
});

Deno.test("only a Unicode emoji, or one of this instance's, can be reacted with", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    // Not Unicode, or not a global emoji of this instance's, named by its bare shortcode.
    for (
        const name of [
            "hello",
            "a",
            "😀😀",
            "nope",
            "dog",
            "dog@b.example",
            "blob@a.test",
            ":blob:",
            ":blob",
            "x:blob:",
            "😀 ",
        ]
    ) {
        assertEquals(await react(test.ctx, "bob", note.id, name), "unknown emoji", name);
    }
    assertEquals(await test.total(note.id), 0);

    // Though no one has reacted with it, it can be undone, as with any emoji.
    assertEquals((await unreact(test.ctx, "bob", note.id, "😀")) !== "missing", true);
    assertEquals(await unreact(test.ctx, "bob", note.id, "hello"), "unknown emoji");
});

Deno.test("a shortcode has letters, digits, underscores and dashes, and a keycap is a Unicode emoji", async () => {
    await using test = await open();

    for (const shortcode of ["blob_cat", "blob-cat", "blob2", "BLOB"]) {
        const id = await createLocalEmoji(test.ctx, shortcode);
        assertEquals(await reactionEmoji(test.ctx, shortcode), { text: null, emoji_id: id });
    }
    for (const keycap of ["1️⃣", "#️⃣"]) {
        assertEquals(await reactionEmoji(test.ctx, keycap), { text: keycap, emoji_id: null });
    }
    for (const name of ["blob:x", "blob@b.example", "blob cat", "1"]) {
        assertEquals(await reactionEmoji(test.ctx, name), undefined, name);
    }
});

Deno.test("reacting to a share reacts to what it shares, and undoing it undoes that", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const share = await createShare(test.ctx, "dave", note.id);

    const reacted = await react(test.ctx, "bob", share.id, "🎉");
    assertEquals(typeof reacted === "object" ? reacted.id : reacted, note.id);
    assertEquals(await test.total(note.id), 1);

    // Undoing one emoji leaves the others.
    await react(test.ctx, "bob", note.id, "blob");
    await unreact(test.ctx, "bob", share.id, "🎉");
    assertEquals(await test.total(note.id), 1);
    await unreact(test.ctx, "bob", note.id, "blob");
    assertEquals(await test.total(note.id), 0);
});

Deno.test("only a note the reactor may see can be reacted to, but a reaction can be undone after", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals(await react(test.ctx, "dave", note.id, "🎉"), "missing");
    assertEquals(await react(test.ctx, "bob", "missing", "🎉"), "missing");
    assertEquals(await unreact(test.ctx, "dave", note.id, "🎉"), "missing");
    assertEquals(await unreact(test.ctx, "dave", note.id, "hello"), "missing");

    await react(test.ctx, "bob", note.id, "🎉");
    await unfollow(test.ctx, "bob", "alice");
    assertEquals((await unreact(test.ctx, "bob", note.id, "🎉")) !== "missing", true);
    assertEquals(await test.total(note.id), 0);
});

Deno.test("a status shows its reactions, and the custom emojis they use among its emojis", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("emojis").set({ category: "Blobs" })
        .where("shortcode", "=", "blob")
        .execute();
    // So that its still picture isn't its picture.
    await test.ctx.db.updateTable("media").set({ preview_sha256: "preview-blob" })
        .where("sha256", "=", "emoji-blob")
        .execute();
    const note = await createNote(test.ctx, "alice");
    await react(test.ctx, "bob", note.id, "blob");
    await react(test.ctx, "dave", note.id, "🎉");
    // A remote instance's reaction with its own emoji.
    await test.ctx.db.insertInto("reactions")
        .values({
            id: test.ctx.ids(),
            account_id: "dave",
            note_id: note.id,
            text: null,
            emoji_id: test.dog ?? "",
            created_at: test.ctx.clock.now(),
        })
        .execute();

    const [status] = await renderStatuses(test.ctx, [note], "bob");
    assertEquals(status?.reactions, [
        {
            name: "blob",
            count: 1,
            remote: false,
            me: true,
            url: "https://social.example/media/emoji-blob",
            static_url: "https://social.example/media/preview-blob",
        },
        { name: "🎉", count: 1, remote: false, me: false },
        {
            name: "dog@b.example",
            count: 1,
            remote: true,
            me: false,
            url: "https://b.example/dog.png",
            static_url: "https://b.example/dog.png",
        },
    ]);
    assertEquals(
        status?.emojis.map((emoji) => [emoji.shortcode, emoji.visible_in_picker, emoji.category]),
        [["blob", true, "Blobs"], ["dog@b.example", false, null]],
    );

    // Without a viewer, no one's reactions are their own.
    const [anyone] = await renderStatuses(test.ctx, [note], null);
    assertEquals(anyone?.reactions?.map((reaction) => reaction.me), [
        undefined,
        undefined,
        undefined,
    ]);
});
