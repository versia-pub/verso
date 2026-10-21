import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext, type TestContextOptions } from "../testing/context.ts";
import { findNote } from "./note_queries.ts";
import { canSee, removeNote, visibleNote } from "./notes.ts";
import { createNote } from "./testing.ts";

const open = async (options: TestContextOptions = {}) => {
    const test = await createTestContext(options);
    for (const id of ["alice", "bob", "dave", "erin"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    // Bob follows alice, and dave only asked to.
    await follow(test.ctx, "bob", "alice");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "dave", "alice");

    return test;
};

const statusesCount = async (ctx: Context, id: string) =>
    (await ctx.db.selectFrom("accounts").select("statuses_count").where("id", "=", id)
        .executeTakeFirstOrThrow()).statuses_count;

Deno.test("who may see a note goes by its visibility, its followers and its mentions", async () => {
    await using test = await open();
    const viewers = [null, "alice", "bob", "carol", "dave", "erin"] as const;
    const seenBy = async (visibility: "public" | "unlisted" | "private" | "direct") => {
        const note = await createNote(test.ctx, "alice", { visibility }, ["carol"]);
        const seen = [];
        for (const viewer of viewers) {
            if (await canSee(test.ctx, note, viewer)) seen.push(viewer ?? "anyone");
        }
        return seen;
    };

    const everyone = ["anyone", "alice", "bob", "carol", "dave", "erin"];
    assertEquals(await seenBy("public"), everyone);
    assertEquals(await seenBy("unlisted"), everyone);
    assertEquals(await seenBy("private"), ["alice", "bob", "carol"]);
    assertEquals(await seenBy("direct"), ["alice", "carol"]);
});

Deno.test("a note is found only by those who may see it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals((await visibleNote(test.ctx, note.id, "bob"))?.id, note.id);
    assertEquals(await visibleNote(test.ctx, note.id, "erin"), undefined);
    assertEquals(await visibleNote(test.ctx, "missing", "alice"), undefined);
});

Deno.test("deleting a note uncounts it and its reply, and tells who could see it", async () => {
    const events: unknown[] = [];
    await using test = await open({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    const parent = await createNote(test.ctx, "bob");
    const reply = await createNote(test.ctx, "alice", {
        visibility: "direct",
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "bob",
    }, ["carol", "bob"]);
    await test.ctx.db.updateTable("notes").set({ replies_count: 1 }).where("id", "=", parent.id)
        .execute();
    events.length = 0;

    assertEquals(await removeNote(test.ctx, reply.id), true);
    assertEquals(await removeNote(test.ctx, reply.id), false);

    assertEquals(await findNote(test.ctx, reply.id), undefined);
    assertEquals((await findNote(test.ctx, parent.id))?.replies_count, 0);
    assertEquals(await statusesCount(test.ctx, "alice"), 0);
    assertEquals(events, [{
        type: "notes.deleted",
        noteId: reply.id,
        accountId: "alice",
        visibility: "direct",
        mentionIds: ["bob", "carol"],
    }]);
});

Deno.test("deleting a note leaves when its author last posted", async () => {
    await using test = await open();
    const first = await createNote(test.ctx, "alice");
    test.clock.advance(60_000);
    await createNote(test.ctx, "alice");

    await removeNote(test.ctx, first.id);

    const alice = await test.ctx.db.selectFrom("accounts").select("last_status_at")
        .where("id", "=", "alice").executeTakeFirstOrThrow();
    assertEquals(alice.last_status_at, test.clock.now());
});

Deno.test("a reply outlives the note it replied to", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "bob");
    const reply = await createNote(test.ctx, "alice", {
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "bob",
    });

    await removeNote(test.ctx, parent.id);

    const kept = await findNote(test.ctx, reply.id);
    assertEquals([kept?.in_reply_to_id, kept?.in_reply_to_account_id], [null, "bob"]);
    assertEquals(await statusesCount(test.ctx, "bob"), 0);
});
