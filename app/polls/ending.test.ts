import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { postNote } from "../notes/notes.ts";
import { createNote } from "../notes/testing.ts";
import { setThreadMuted } from "../notes/thread_mutes.ts";
import { createTestContext } from "../testing/context.ts";
import { endedPollsQueue, endPolls } from "./ending.ts";
import { insertPoll, pollOf } from "./poll_queries.ts";
import { changePoll, vote } from "./polls.ts";

/** alice, who asks which colour in a poll of an hour, which bob and carol answer. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol", "dave"]) await createLocalAccount(test.ctx, id);

    const poll = { options: ["Red", "Blue"], expiresIn: 3600, multiple: true, hideTotals: false };
    const note = await postNote(test.ctx, "alice", {
        text: "Which?",
        format: "text/plain",
        spoilerText: "",
        poll,
    });
    if (note === undefined) throw new Error("Not posted");
    const asked = await pollOf(test.ctx, note.id);
    if (asked === undefined) throw new Error("No poll");

    await vote(test.ctx, "bob", asked.id, [0, 1]);
    await vote(test.ctx, "carol", asked.id, [1]);

    /** The poll notifications, as whom they notify. */
    const notified = async () =>
        (await test.ctx.db.selectFrom("notifications").selectAll()
            .where("type", "=", "poll")
            .orderBy("account_id")
            .execute())
            .map((row) => `${row.account_id} ${row.from_account_id} ${row.note_id === note.id}`);

    return { ...test, note, poll, asked, notified };
};

Deno.test("a poll that ends notifies its author and voters, once", async () => {
    await using test = await open();

    test.clock.advance(3599_000);
    await endPolls(test.ctx);
    assertEquals(await test.notified(), []);

    test.clock.advance(1000);
    await endPolls(test.ctx);
    assertEquals(await test.notified(), [
        "alice alice true",
        "bob alice true",
        "carol alice true",
    ]);

    test.clock.advance(60_000);
    await endPolls(test.ctx);
    assertEquals((await test.notified()).length, 3);
});

Deno.test("a poll that is edited to end later notifies again when it does", async () => {
    await using test = await open();
    await setThreadMuted(test.ctx, "carol", test.note.id, true);
    test.clock.advance(3600_000);
    await endPolls(test.ctx);
    // carol muted its thread.
    assertEquals(await test.notified(), ["alice alice true", "bob alice true"]);

    await changePoll(test.ctx, test.note.id, test.asked, { ...test.poll, expiresIn: 600 });
    test.clock.advance(599_000);
    await endPolls(test.ctx);
    assertEquals((await test.notified()).length, 2);

    test.clock.advance(1000);
    await endPolls(test.ctx);
    assertEquals(await test.notified(), [
        "alice alice true",
        "alice alice true",
        "bob alice true",
        "bob alice true",
    ]);
});

Deno.test("many polls end in one run, and remote voters aren't notified", async () => {
    await using test = await open();
    const instance = await createInstance(test.ctx, "remote.example");
    const remote = await createRemoteAccount(test.ctx, "erin", instance);
    await test.ctx.db.insertInto("poll_votes")
        .values({
            id: test.ctx.ids(),
            poll_id: test.asked.id,
            account_id: remote,
            choice: 0,
            created_at: test.clock.now(),
        })
        .execute();

    for (let i = 0; i < 100; i++) {
        await postNote(test.ctx, "dave", {
            text: `Which ${i}?`,
            format: "text/plain",
            spoilerText: "",
            poll: test.poll,
        });
    }
    test.clock.advance(3600_000);
    await endPolls(test.ctx);

    assertEquals((await test.notified()).length, 3 + 100);
    assertEquals((await test.notified()).some((row) => row.startsWith(remote)), false);
});

Deno.test("a remote poll that ends notifies only its local voters", async () => {
    await using test = await open();
    const instance = await createInstance(test.ctx, "remote.example");
    const erin = await createRemoteAccount(test.ctx, "erin", instance);
    const note = await createNote(test.ctx, erin, { instance_id: instance, remote_id: "1" });
    await insertPoll(test.ctx, note.id, {
        options: ["Yes", "No"],
        multiple: false,
        hideTotals: false,
        expiresAt: new Date(test.clock.now().getTime() + 60_000),
    });
    const poll = await pollOf(test.ctx, note.id);
    await vote(test.ctx, "dave", poll?.id ?? "", [0]);

    test.clock.advance(60_000);
    await endPolls(test.ctx);
    const notified = await test.ctx.db.selectFrom("notifications").select("account_id")
        .where("note_id", "=", note.id)
        .execute();
    assertEquals(notified, [{ account_id: "dave" }]);
});

Deno.test("the polls that ended are found every minute", () => {
    assertEquals(tasks.filter((task) => task.queue === endedPollsQueue), [
        { queue: endedPollsQueue, every: "minute" },
    ]);
    assertEquals(queues[endedPollsQueue].concurrency, 1);
});
