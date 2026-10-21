import { assertEquals } from "@std/assert";
import { findAccount } from "../accounts/accounts.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext, type TestContextOptions } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { findNote, mentionsOf, tagsOf } from "./note_queries.ts";
import { canSee, type Draft, postNote, removeNote, visibleNote } from "./notes.ts";
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

/** Posts `text` as plain text, with no content warning unless `draft` gives one. */
const post = (ctx: Context, accountId: string, text: string, draft: Partial<Draft> = {}) =>
    postNote(ctx, accountId, { text, format: "text/plain", spoilerText: "", ...draft });

const user = "https://social.example/.versia/v0.6/entities/User";

const mention = (uri: string, username: string) =>
    `<span class="h-card" translate="no"><a href="${uri}" class="u-url mention">` +
    `@<span>${username}</span></a></span>`;

Deno.test("a posted note links who it mentions and its hashtags, and is counted", async () => {
    const events: unknown[] = [];
    await using test = await open({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    events.length = 0;

    const note = await post(
        test.ctx,
        "alice",
        "Hi @bob, @Carol@B.Example and @nobody #Verso #verso",
    );
    if (note === undefined) throw new Error("Not posted");

    assertEquals(
        note.content_html,
        `<p>Hi ${mention(`${user}/bob`, "bob")}, ` +
            `${mention("https://b.example/.versia/v0.6/entities/User/carol", "Carol")} and ` +
            `@nobody <a href="https://social.example/tags/verso" class="mention hashtag" ` +
            `rel="tag">#<span>Verso</span></a> <a href="https://social.example/tags/verso" ` +
            `class="mention hashtag" rel="tag">#<span>verso</span></a></p>`,
    );
    assertEquals((await mentionsOf(test.ctx, [note.id])).get(note.id), ["bob", "carol"]);
    assertEquals((await tagsOf(test.ctx, [note.id])).get(note.id), ["verso"]);
    assertEquals(await statusesCount(test.ctx, "alice"), 1);
    assertEquals(events, [{ type: "notes.posted", noteId: note.id }]);
});

Deno.test("a mention is linked however it is written", async () => {
    await using test = await open();
    const note = await post(test.ctx, "alice", "@bob @BOB");

    const bob = mention(`${user}/bob`, "bob");
    assertEquals(note?.content_html, `<p>${bob} ${mention(`${user}/bob`, "BOB")}</p>`);
});

Deno.test("a note is written in Markdown if its author says so", async () => {
    await using test = await open();
    const note = await post(test.ctx, "alice", "Hi *@bob*", { format: "text/markdown" });

    assertEquals(
        [note?.content, note?.content_format, note?.content_html],
        ["Hi *@bob*", "text/markdown", `<p>Hi <em>${mention(`${user}/bob`, "bob")}</em></p>`],
    );
});

Deno.test("a note has its author's defaults, unless they choose, and a warning makes it sensitive", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ default_visibility: "private", default_sensitive: true, default_language: "de" })
        .where("id", "=", "alice")
        .execute();
    const settings = async (accountId: string, draft: Partial<Draft> = {}) => {
        const note = await post(test.ctx, accountId, "Hi", draft);
        return [note?.visibility, note?.sensitive, note?.language, note?.spoiler_text];
    };

    assertEquals(await settings("alice"), ["private", true, "de", ""]);
    assertEquals(
        await settings("alice", { visibility: "direct", sensitive: false, language: "en" }),
        ["direct", false, "en", ""],
    );
    assertEquals(await settings("bob"), ["public", false, null, ""]);
    assertEquals(
        await settings("bob", { sensitive: false, spoilerText: "Food" }),
        ["public", true, null, "Food"],
    );
});

Deno.test("a reply is to a note its author may see, which counts it", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "alice", { visibility: "private" });

    const reply = await post(test.ctx, "bob", "Hi", { inReplyToId: parent.id });
    assertEquals([reply?.in_reply_to_id, reply?.in_reply_to_account_id], [parent.id, "alice"]);
    assertEquals((await findNote(test.ctx, parent.id))?.replies_count, 1);

    assertEquals(await post(test.ctx, "erin", "Hi", { inReplyToId: parent.id }), undefined);
    assertEquals(await post(test.ctx, "erin", "Hi", { inReplyToId: "missing" }), undefined);
    assertEquals(await statusesCount(test.ctx, "erin"), 0);
    assertEquals((await findNote(test.ctx, parent.id))?.replies_count, 1);
});

Deno.test("another instance's user is fetched to be mentioned", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "alice");
    await createLocalAccount(network.instances["b.test"].ctx, "bob");

    const note = await post(a, "alice", "Hi @bob@b.test");
    if (note === undefined) throw new Error("Not posted");

    const [bob] = (await mentionsOf(a, [note.id])).get(note.id) ?? [];
    const row = await findAccount(a, bob ?? "");
    assertEquals([row?.username, row?.domain], ["bob", "b.test"]);
});

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
