import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { deliverQueue } from "../federation/deliver.ts";
import { createInstance } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { postNote } from "../notes/notes.ts";
import { createNote } from "../notes/testing.ts";
import { follow } from "../graph/follows.ts";
import { createTestContext } from "../testing/context.ts";
import { insertPoll, pollOf } from "./poll_queries.ts";
import { castVotes } from "./polls.ts";
import { pollUpdatesQueue, updateDelayMs } from "./updating.ts";

/** alice's poll, of an hour, which bob and carol may vote in, and erin on c.example follows her. */
const open = async (hideTotals = false) => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    // So that the status is sent somewhere.
    await createRemoteAccount(test.ctx, "erin", await createInstance(test.ctx, "c.example"));
    await follow(test.ctx, "erin", "alice");

    const note = await postNote(test.ctx, "alice", {
        text: "Which?",
        format: "text/plain",
        spoilerText: "",
        poll: { options: ["Red", "Blue"], expiresIn: 3600, multiple: false, hideTotals },
    });
    assertExists(note);
    const poll = await pollOf(test.ctx, note.id);
    assertExists(poll);

    /** The poll updates queued, when each runs. */
    const queued = async () =>
        (await test.ctx.db.selectFrom("jobs").select(["run_at", "payload"])
            .where("queue", "=", pollUpdatesQueue).orderBy("run_at").execute())
            .map((job) => [job.run_at.getTime() - test.clock.now().getTime(), job.payload]);

    /** The notes queued for delivery, which a poll update sends. */
    const sendsOf = async () =>
        (await test.ctx.db.selectFrom("jobs").select("payload")
            .where("queue", "=", deliverQueue).execute()).length;

    return { ...test, note, poll, queued, sendsOf };
};

Deno.test("a vote queues one update of a poll, three minutes later, for all the votes before it", async () => {
    await using test = await open();

    await test.ctx.transaction((tx) => castVotes(tx, "bob", test.poll.id, [0]));
    test.clock.advance(60_000);
    await test.ctx.transaction((tx) => castVotes(tx, "carol", test.poll.id, [1]));

    assertEquals(await test.queued(), [[updateDelayMs - 60_000, { pollId: test.poll.id }]]);

    const before = await test.sendsOf();
    test.clock.advance(updateDelayMs - 60_000);
    await drain(test.ctx, { [pollUpdatesQueue]: queues[pollUpdatesQueue] });

    assertEquals(await test.sendsOf() - before, 1);
});

Deno.test("a poll that hides its totals, or that ended, is not updated", async () => {
    await using hidden = await open(true);
    await hidden.ctx.transaction((tx) => castVotes(tx, "bob", hidden.poll.id, [0]));
    assertEquals(await hidden.queued(), []);

    await using test = await open();
    await test.ctx.transaction((tx) => castVotes(tx, "bob", test.poll.id, [0]));
    assertEquals((await test.queued()).length, 1);

    // Its results are sent when it ends, so the update is not.
    const before = await test.sendsOf();
    test.clock.advance(3600_000);
    await drain(test.ctx, { [pollUpdatesQueue]: queues[pollUpdatesQueue] });
    assertEquals((await test.queued()).length, 0);
    assertEquals(await test.sendsOf(), before);
});

Deno.test("the update of a poll that was deleted is not sent", async () => {
    await using test = await open();
    await test.ctx.transaction((tx) => castVotes(tx, "bob", test.poll.id, [0]));

    await test.ctx.db.deleteFrom("polls").where("id", "=", test.poll.id).execute();
    test.clock.advance(updateDelayMs);
    await drain(test.ctx, { [pollUpdatesQueue]: queues[pollUpdatesQueue] });

    assertEquals(await test.queued(), []);
});

Deno.test("a vote in a remote poll queues no update", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "carol", await createInstance(test.ctx, "b.example"));
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "q1" });
    await insertPoll(test.ctx, note.id, {
        options: ["Red", "Blue"],
        multiple: false,
        hideTotals: false,
        expiresAt: null,
    });
    const poll = await pollOf(test.ctx, note.id);

    await test.ctx.transaction((tx) => castVotes(tx, "alice", poll?.id ?? "", [0]));

    const jobs = await test.ctx.db.selectFrom("jobs").select("id").where(
        "queue",
        "=",
        pollUpdatesQueue,
    ).execute();
    assertEquals(jobs, []);
});

Deno.test("each poll is updated by a job of its own", async () => {
    await using test = await open();
    const another = await postNote(test.ctx, "alice", {
        text: "And?",
        format: "text/plain",
        spoilerText: "",
        poll: { options: ["Yes", "No"], expiresIn: 3600, multiple: false, hideTotals: false },
    });
    const second = await pollOf(test.ctx, another?.id ?? "");
    assertExists(second);

    await test.ctx.transaction((tx) => castVotes(tx, "bob", test.poll.id, [0]));
    await test.ctx.transaction((tx) => castVotes(tx, "bob", second.id, [1]));

    assertEquals((await test.queued()).length, 2);
});
