import { assertEquals } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { findNote } from "../notes/note_queries.ts";
import { findShare } from "../notes/share_queries.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { createNote } from "../notes/testing.ts";
import type { DomainEvent } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { isShareEvent } from "./events.ts";
import { like, unlike } from "./likes.ts";
import { share, unshare } from "./shares.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    /** How many boosts a status has, and how many statuses its booster `by` has. */
    const counts = async (noteId: string, by: string) => [
        (await findNote(test.ctx, noteId))?.shares_count,
        (await findAccount(test.ctx, by))?.statuses_count,
    ];

    return { ...test, counts };
};

Deno.test("a note is shared once, counted once, and its share can be undone", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    const first = await share(test.ctx, "bob", note.id, "unlisted");
    const again = await share(test.ctx, "bob", note.id);
    assertEquals(typeof first === "object" && first.visibility, "unlisted");
    assertEquals(again, first);
    assertEquals(await test.counts(note.id, "bob"), [1, 1]);

    assertEquals((await unshare(test.ctx, "bob", note.id))?.shares_count, 0);
    assertEquals(await test.counts(note.id, "bob"), [0, 0]);
    assertEquals(await findShare(test.ctx, "bob", note.id), undefined);
});

Deno.test("a share is for the sharer's default visibility, but never direct", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const visibilityOf = async (by: string, visibility: "unlisted" | "direct") => {
        await test.ctx.db.updateTable("accounts").set({ default_visibility: visibility })
            .where("id", "=", by).execute();
        const result = await share(test.ctx, by, note.id);
        return typeof result === "object" ? result.visibility : result;
    };

    assertEquals(await visibilityOf("bob", "unlisted"), "unlisted");
    assertEquals(await visibilityOf("dave", "direct"), "private");
});

Deno.test("only public and unlisted notes the sharer may see can be shared", async () => {
    await using test = await open();
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals(await share(test.ctx, "dave", hidden.id), "missing");
    assertEquals(await share(test.ctx, "bob", "missing"), "missing");
    assertEquals(await share(test.ctx, "bob", hidden.id), "unshareable");
    assertEquals(await share(test.ctx, "alice", hidden.id), "unshareable");
    assertEquals(await test.counts(hidden.id, "bob"), [0, 0]);
});

Deno.test("sharing, liking or replying to a share does it to what it shares", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const shared = await share(test.ctx, "bob", note.id);
    if (typeof shared !== "object") throw new Error(`Not shared: ${shared}`);

    const again = await share(test.ctx, "dave", shared.id);
    assertEquals(typeof again === "object" && again.reblog_of_id, note.id);
    assertEquals((await like(test.ctx, "dave", shared.id))?.likes_count, 1);
    const unliked = await unlike(test.ctx, "dave", shared.id);
    assertEquals([unliked?.id, unliked?.likes_count], [note.id, 0]);

    const reply = await postNote(test.ctx, "dave", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
        inReplyToId: shared.id,
    });
    assertEquals([reply?.in_reply_to_id, reply?.in_reply_to_account_id], [note.id, "alice"]);

    assertEquals((await unshare(test.ctx, "dave", shared.id))?.id, note.id);
    assertEquals(await findShare(test.ctx, "dave", note.id), undefined);
});

Deno.test("a share has nothing to edit", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const shared = await share(test.ctx, "bob", note.id);
    if (typeof shared !== "object") throw new Error(`Not shared: ${shared}`);

    assertEquals(await editNote(test.ctx, "bob", shared.id, { text: "Hi" }), undefined);
});

Deno.test("a share can be undone after its note can't be seen, but no one else's", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "unlisted" });
    await share(test.ctx, "bob", note.id);
    await test.ctx.db.updateTable("notes").set({ visibility: "private" })
        .where("id", "=", note.id).execute();
    await unfollow(test.ctx, "bob", "alice");

    assertEquals(await unshare(test.ctx, "dave", note.id), undefined);
    assertEquals((await unshare(test.ctx, "bob", note.id))?.shares_count, 0);
});

Deno.test("boosting and undoing it tell the rest of Verso the boost's visibility", async () => {
    const events: DomainEvent[] = [];
    await using test = await createTestContext({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const note = await createNote(test.ctx, "alice");

    await share(test.ctx, "bob", note.id, "private");
    await unshare(test.ctx, "bob", note.id);

    assertEquals(
        events.filter(isShareEvent).map((event) => [event.type, event.visibility]),
        [["interactions.shared", "private"], ["interactions.unshared", "private"]],
    );
});
