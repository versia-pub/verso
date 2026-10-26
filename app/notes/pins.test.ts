import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { createTestContext } from "../testing/context.ts";
import { pinnedAmong, pinnedNotes } from "./pin_queries.ts";
import { pin, pinLimit, unpin } from "./pins.ts";
import { createNote, createShare } from "./testing.ts";

/** alice, and bob, who follows her. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    /** The result of alice pinning `noteId`: the status id, or why it wasn't pinned. */
    const pinning = async (noteId: string) => {
        const result = await pin(test.ctx, "alice", noteId);
        return typeof result === "string" ? result : result.id;
    };

    return { ...test, pinning };
};

Deno.test("an author pins their notes, once each, and unpins them", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const other = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals(await test.pinning(note.id), note.id);
    assertEquals(await test.pinning(note.id), note.id);
    assertEquals(await test.pinning(other.id), other.id);
    assertEquals(
        await pinnedAmong(test.ctx, "alice", [note.id, other.id]),
        new Set([note.id, other.id]),
    );
    // Only alice has pinned them.
    assertEquals((await pinnedAmong(test.ctx, "bob", [note.id])).size, 0);

    assertEquals((await unpin(test.ctx, "alice", note.id))?.id, note.id);
    assertEquals((await unpin(test.ctx, "alice", note.id))?.id, note.id);
    assertEquals(await pinnedAmong(test.ctx, "alice", [note.id, other.id]), new Set([other.id]));
    assertEquals(await unpin(test.ctx, "alice", "missing"), undefined);
});

Deno.test("only one's own notes can be pinned, not shares nor direct ones", async () => {
    await using test = await open();
    const bobs = await createNote(test.ctx, "bob");
    const direct = await createNote(test.ctx, "alice", { visibility: "direct" });
    const share = await createShare(test.ctx, "alice", bobs.id);
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });

    assertEquals(await test.pinning(bobs.id), "unpinnable");
    assertEquals(await test.pinning(direct.id), "unpinnable");
    assertEquals(await test.pinning(share.id), "unpinnable");
    assertEquals(await test.pinning(hidden.id), "missing");
    assertEquals(await test.pinning("missing"), "missing");
});

Deno.test("an author pins at most 5 notes", async () => {
    await using test = await open();
    const notes = [];
    for (let i = 0; i <= pinLimit; i++) notes.push(await createNote(test.ctx, "alice"));
    const [first, ...rest] = notes;
    const last = rest.pop();

    // Other accounts' pins don't count.
    await pin(test.ctx, "bob", (await createNote(test.ctx, "bob")).id);
    for (const note of [first, ...rest]) assertEquals(await test.pinning(note?.id ?? ""), note?.id);
    assertEquals(await test.pinning(last?.id ?? ""), "full");
    // A status that is already pinned stays pinned.
    assertEquals(await test.pinning(first?.id ?? ""), first?.id);

    await unpin(test.ctx, "alice", first?.id ?? "");
    assertEquals(await test.pinning(last?.id ?? ""), last?.id);
});

Deno.test("an account's pinned notes are those with the visibilities given, the latest pinned first", async () => {
    await using test = await open();
    const older = await createNote(test.ctx, "alice");
    const unlisted = await createNote(test.ctx, "alice", { visibility: "unlisted" });
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    await createNote(test.ctx, "alice");
    for (const note of [unlisted, hidden, older]) {
        test.clock.advance(1);
        await pin(test.ctx, "alice", note.id);
    }
    const ids = async (visibilities: ("public" | "unlisted" | "private")[]) =>
        (await pinnedNotes(test.ctx, "alice", visibilities)).map((note) => note.id);

    assertEquals(await ids(["public", "unlisted", "private"]), [older.id, hidden.id, unlisted.id]);
    assertEquals(await ids(["public", "unlisted"]), [older.id, unlisted.id]);
    assertEquals((await pinnedNotes(test.ctx, "bob", ["public"])).length, 0);
});
