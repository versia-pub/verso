import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import type { InteractionReceived, LikeEvent } from "../interactions/events.ts";
import { like } from "../interactions/likes.ts";
import { share, unshare } from "../interactions/shares.ts";
import { subscribe } from "../kernel/pubsub.ts";
import type { NoteDeleted, NoteReceived } from "../notes/events.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createTestContext } from "../testing/context.ts";
import { statusMessages, streamStatuses } from "./statuses.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const heard: unknown[] = [];
    subscribe(test.ctx, statusMessages, (message) => Promise.resolve(void heard.push(message)));

    return { ...test, heard };
};

Deno.test("statuses and boosts local users post, edit and delete are sent to every process", async () => {
    await using test = await open();
    const note = await postNote(test.ctx, "alice", {
        text: "Hi @bob",
        format: "text/plain",
        spoilerText: "",
        visibility: "unlisted",
    });
    if (note === undefined) throw new Error("Not posted");

    await editNote(test.ctx, "alice", note.id, { text: "Hello @bob" });
    const boost = await share(test.ctx, "bob", note.id, "private");
    if (typeof boost === "string") throw new Error("Not boosted");
    // Neither a status nor a boost.
    await like(test.ctx, "bob", note.id);
    await unshare(test.ctx, "bob", note.id);
    await removeNote(test.ctx, note.id);

    assertEquals(test.heard, [
        { event: "update", noteId: note.id },
        { event: "status.update", noteId: note.id },
        { event: "update", noteId: boost.id },
        {
            event: "delete",
            noteId: boost.id,
            accountId: "bob",
            visibility: "private",
            mentionIds: [],
        },
        {
            event: "delete",
            noteId: note.id,
            accountId: "alice",
            visibility: "unlisted",
            mentionIds: ["bob"],
        },
    ]);
});

Deno.test("statuses and boosts remote instances send are sent to every process, new or edited", async () => {
    await using test = await open();
    const received = (edited: boolean): NoteReceived => ({
        type: "notes.received",
        noteId: `note-${edited}`,
        edited,
        fetched: false,
    });
    const interaction = (kind: InteractionReceived["kind"]): InteractionReceived => ({
        type: "interactions.received",
        kind,
        id: kind,
        accountId: "dave",
        noteId: "note",
    });
    const liked: LikeEvent = {
        type: "interactions.liked",
        likeId: "like",
        accountId: "bob",
        noteId: "note",
    };

    for (
        const event of [
            received(false),
            received(true),
            interaction("share"),
            interaction("like"),
            interaction("reaction"),
            liked,
        ]
    ) {
        await streamStatuses(test.ctx, event);
    }

    assertEquals(test.heard, [
        { event: "update", noteId: "note-false" },
        { event: "status.update", noteId: "note-true" },
        { event: "update", noteId: "share" },
    ]);
});

Deno.test("a deleted status's mentions fit in its message, as many as a status may have", async () => {
    await using test = await open();
    const event: NoteDeleted = {
        type: "notes.deleted",
        noteId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        // The longest name.
        visibility: "unlisted",
        mentionIds: Array.from({ length: 150 }, () => crypto.randomUUID()),
        inReplyToAccountId: null,
    };

    await streamStatuses(test.ctx, event);
    assertEquals(test.heard.length, 1);
});
