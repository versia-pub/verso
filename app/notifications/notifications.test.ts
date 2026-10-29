import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { like, unlike } from "../interactions/likes.ts";
import { react, unreact } from "../interactions/reactions.ts";
import { share, unshare } from "../interactions/shares.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import type { NotePosted } from "../notes/events.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { createTestContext } from "../testing/context.ts";
import { notified, NotifyJob, notifyOf, notifyQueue } from "./notifications.ts";
import { groupKeysOf, notificationsOf } from "./testing.ts";

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

        // So the followers it notifies are notified before what comes next.
        await drain(test.ctx, queues);
        return note;
    };
    const lock = async (id: string) => {
        await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", id)
            .execute();
    };

    /** The notifications of `id`, once the jobs that notify are done. */
    const of = async (id: string) => {
        await drain(test.ctx, queues);
        return await notificationsOf(test.ctx, id);
    };

    return { ...test, post, lock, of };
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
    await test.ctx.transaction((tx) => notifyOf(tx, posted));

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

Deno.test("followers and boosters are notified by jobs, 100 to a job, after the status is posted", async () => {
    await using test = await open();
    const followers = Array.from({ length: 101 }, (_, n) => `u${n}`);
    for (const id of followers) {
        await createLocalAccount(test.ctx, id);
        await follow(test.ctx, id, "alice", { notify: true });
    }
    const note = await postNote(test.ctx, "alice", {
        text: "Hi @bob",
        format: "text/plain",
        spoilerText: "",
    });
    if (note === undefined) throw new Error("Not posted");
    await share(test.ctx, "u0", note.id);
    await share(test.ctx, "bob", note.id);
    await editNote(test.ctx, "alice", note.id, { text: "Hi @bob again" });

    const jobs = await test.ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", notifyQueue)
        .execute();
    const queued = jobs.map((job) => NotifyJob.parse(job.payload))
        .map(({ type, accountIds }) => `${type} ${accountIds.length}`);
    assertEquals(queued.toSorted(), ["status 1", "status 100", "update 2"]);
    assertEquals(await notificationsOf(test.ctx, "u100"), []);
    assertEquals(await notificationsOf(test.ctx, "bob"), [`mention alice ${note.id}`]);

    assertEquals(await test.of("u100"), [`status alice ${note.id}`]);
    assertEquals(await test.of("u0"), [`update alice ${note.id}`, `status alice ${note.id}`]);
    assertEquals(await test.of("bob"), [`update alice ${note.id}`, `mention alice ${note.id}`]);
});

Deno.test("a job notifies no one of a status deleted before it ran", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice", { notify: true });
    const note = await postNote(test.ctx, "alice", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    if (note === undefined) throw new Error("Not posted");
    const queued = () =>
        test.ctx.db.selectFrom("jobs").select("last_error").where("queue", "=", notifyQueue)
            .execute();
    assertEquals((await queued()).length, 1);

    await removeNote(test.ctx, note.id);
    assertEquals(await test.of("bob"), []);
    // Done, rather than kept to be tried again.
    assertEquals(await queued(), []);
});

Deno.test("a job that isn't a notify job is given up on", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: notifyQueue, payload: { noteId: "n1" } });

    await drain(test.ctx, queues);
    const jobs = await test.ctx.db.selectFrom("jobs").select("last_error")
        .where("queue", "=", notifyQueue)
        .execute();
    assertEquals(
        jobs.map((job) => job.last_error?.split("\n")[0]),
        ["PermanentFailure: The job isn't a notify job"],
    );
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

Deno.test("likes, boosts, reactions and follows are grouped by status for 12 hours", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi");
    const other = await test.post("alice", "Hello");
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);

    await like(test.ctx, "bob", note.id);
    await share(test.ctx, "bob", note.id);
    await react(test.ctx, "bob", note.id, "👍");
    await follow(test.ctx, "bob", "alice");
    test.clock.advance(11 * 3_600_000);
    await like(test.ctx, "carol", note.id);
    await like(test.ctx, "carol", other.id);
    await react(test.ctx, "carol", note.id, "🎉");
    await follow(test.ctx, "carol", "alice");
    await test.post("bob", "Hi @alice");

    assertEquals(await groupKeysOf(test.ctx, "alice"), [
        "-",
        `follow--${hour}`,
        `reaction-${note.id}-${hour}`,
        `favourite-${other.id}-${hour + 11}`,
        `favourite-${note.id}-${hour}`,
        `follow--${hour}`,
        `reaction-${note.id}-${hour}`,
        `reblog-${note.id}-${hour}`,
        `favourite-${note.id}-${hour}`,
    ]);
});

Deno.test("a group takes notifications until 12 hours after it started", async () => {
    await using test = await open();
    for (const id of ["erin", "frank"]) await createLocalAccount(test.ctx, id);
    const note = await test.post("alice", "Hi");
    const hour = Math.floor(test.clock.now().getTime() / 3_600_000);

    await like(test.ctx, "bob", note.id);
    await follow(test.ctx, "bob", "alice");
    test.clock.advance(11 * 3_600_000);
    await like(test.ctx, "carol", note.id);
    test.clock.advance(3_600_000);
    await like(test.ctx, "erin", note.id);
    // Another user's group of follows, started since, is theirs alone.
    await follow(test.ctx, "carol", "erin");
    test.clock.advance(3_600_000);
    await like(test.ctx, "frank", note.id);
    await follow(test.ctx, "carol", "alice");

    assertEquals(await groupKeysOf(test.ctx, "alice"), [
        `follow--${hour + 13}`,
        `favourite-${note.id}-${hour + 12}`,
        `favourite-${note.id}-${hour + 12}`,
        `favourite-${note.id}-${hour}`,
        `follow--${hour}`,
        `favourite-${note.id}-${hour}`,
    ]);
});

Deno.test("each notification is sent to every process, for its user to stream", async () => {
    await using test = await open();
    const heard: unknown[] = [];
    subscribe(test.ctx, notified, (message) => Promise.resolve(void heard.push(message)));

    await test.post("alice", "Hi @bob and @carol");

    const rows = await test.ctx.db.selectFrom("notifications").select(["id", "account_id"])
        .orderBy("id").execute();
    assertEquals(
        heard,
        rows.map((row) => ({ accountId: row.account_id, notificationId: row.id })),
    );
    assertEquals(rows.map((row) => row.account_id).sort(), ["bob", "carol"]);
});
