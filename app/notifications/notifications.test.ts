import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { like, unlike } from "../interactions/likes.ts";
import { react, unreact } from "../interactions/reactions.ts";
import { share, unshare } from "../interactions/shares.ts";
import type { NotePosted } from "../notes/events.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { notifyOf } from "./notifications.ts";
import { notificationsOf } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "remote.example");
    await createRemoteAccount(test.ctx, "dave", "remote.example");

    const post = async (accountId: string, text: string, inReplyToId?: string) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            inReplyToId,
        });
        if (note === undefined) throw new Error("Not posted");
        return note;
    };
    const lock = async (id: string) => {
        await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", id)
            .execute();
    };

    return { ...test, post, lock, of: (id: string) => notificationsOf(test.ctx, id) };
};

Deno.test("likes, boosts and reactions notify the author, until they are undone", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi");

    await like(test.ctx, "bob", note.id);
    await share(test.ctx, "carol", note.id);
    await react(test.ctx, "bob", note.id, "👍");
    assertEquals(await test.of("alice"), [
        `reaction bob ${note.id}`,
        `reblog carol ${note.id}`,
        `favourite bob ${note.id}`,
    ]);

    await unlike(test.ctx, "bob", note.id);
    await unshare(test.ctx, "carol", note.id);
    await unreact(test.ctx, "bob", note.id, "👍");
    assertEquals(await test.of("alice"), []);
});

Deno.test("no one is notified of what they do to their own statuses", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi @alice");

    await like(test.ctx, "alice", note.id);
    await share(test.ctx, "alice", note.id);
    await react(test.ctx, "alice", note.id, "👍");
    await editNote(test.ctx, "alice", note.id, { text: "Hi again @alice" });
    assertEquals(await test.of("alice"), []);
});

Deno.test("only local authors are notified", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "dave", {
        instance_id: "remote.example",
        remote_id: "hi",
    });

    await like(test.ctx, "bob", note.id);
    await share(test.ctx, "bob", note.id);
    await react(test.ctx, "bob", note.id, "👍");
    assertEquals(await test.of("dave"), []);
});

Deno.test("mentioned local users are notified, once, even after edits", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi @bob");
    assertEquals(await test.of("bob"), [`mention alice ${note.id}`]);

    await editNote(test.ctx, "alice", note.id, { text: "Hi @bob and @carol" });
    assertEquals(await test.of("bob"), [`mention alice ${note.id}`]);
    assertEquals(await test.of("carol"), [`mention alice ${note.id}`]);
});

Deno.test("followers notified of a status are notified when an edit mentions them", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice", { notify: true });
    const note = await test.post("alice", "Hi");

    await editNote(test.ctx, "alice", note.id, { text: "Hi @bob" });
    assertEquals(await test.of("bob"), [`mention alice ${note.id}`, `status alice ${note.id}`]);
});

Deno.test("remote users a status mentions aren't notified", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", {}, ["dave", "bob"]);
    const posted: NotePosted = { type: "notes.posted", noteId: note.id };
    await notifyOf(test.ctx, posted);

    assertEquals(await test.of("bob"), [`mention alice ${note.id}`]);
    assertEquals(await test.of("dave"), []);
});

Deno.test("followers who asked are notified of statuses, but not of replies to others", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice", { notify: true });
    await follow(test.ctx, "carol", "alice", { notify: true });
    await follow(test.ctx, "carol", "bob");

    const first = await test.post("alice", "Hi");
    const own = await test.post("alice", "And more", first.id);
    const other = await test.post("bob", "Hello");
    await test.post("alice", "Hi bob", other.id);
    const mentioning = await test.post("alice", "Hi @carol");

    assertEquals(await test.of("bob"), [
        `status alice ${mentioning.id}`,
        `status alice ${own.id}`,
        `status alice ${first.id}`,
        "follow carol",
    ]);
    // Bob's status doesn't notify Carol, who didn't ask, and the one mentioning her only once.
    assertEquals(await test.of("carol"), [
        `mention alice ${mentioning.id}`,
        `status alice ${own.id}`,
        `status alice ${first.id}`,
    ]);
});

Deno.test("direct statuses notify only those they mention", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice", { notify: true });
    const note = await postNote(test.ctx, "alice", {
        text: "Hi @carol",
        format: "text/plain",
        spoilerText: "",
        visibility: "direct",
    });

    assertEquals(await test.of("bob"), []);
    assertEquals(await test.of("carol"), [`mention alice ${note?.id}`]);
});

Deno.test("local users who boosted a status are notified of its edits", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi");
    await share(test.ctx, "bob", note.id);
    await createShare(test.ctx, "dave", note.id, { instance_id: "remote.example", remote_id: "s" });

    await editNote(test.ctx, "alice", note.id, { text: "Hi again" });
    await editNote(test.ctx, "alice", note.id, { text: "Hi once more" });
    assertEquals(await test.of("bob"), [`update alice ${note.id}`, `update alice ${note.id}`]);
    assertEquals(await test.of("carol"), []);
    assertEquals(await test.of("dave"), []);
});

Deno.test("deleting a status deletes its notifications", async () => {
    await using test = await open();
    await follow(test.ctx, "carol", "alice", { notify: true });
    const note = await test.post("alice", "Hi @bob");
    await like(test.ctx, "bob", note.id);

    await removeNote(test.ctx, note.id);
    assertEquals(await test.of("alice"), ["follow carol"]);
    assertEquals(await test.of("bob"), []);
    assertEquals(await test.of("carol"), []);
});

Deno.test("follows notify the followee, until they are undone", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "dave", "alice");
    assertEquals(await test.of("alice"), ["follow dave", "follow bob"]);

    await unfollow(test.ctx, "bob", "alice");
    await rejectFollow(test.ctx, "dave", "alice");
    assertEquals(await test.of("alice"), []);
});

Deno.test("follow requests notify until they are accepted or rejected", async () => {
    await using test = await open();
    await test.lock("alice");
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");
    assertEquals(await test.of("alice"), ["follow_request carol", "follow_request bob"]);

    // Accepting doesn't notify of a follow they approved.
    await acceptFollow(test.ctx, "bob", "alice");
    await rejectFollow(test.ctx, "carol", "alice");
    assertEquals(await test.of("alice"), []);
});

Deno.test("remote followees aren't notified", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "dave");
    assertEquals(await test.of("dave"), []);

    await acceptFollow(test.ctx, "alice", "dave");

    assertEquals(await test.of("dave"), []);
    assertEquals(await test.of("alice"), []);
});
