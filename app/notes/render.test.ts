import { assertEquals, assertRejects } from "@std/assert";
import { Status, StatusEdit } from "@versia/client-api";
import { publicAccounts } from "../accounts/public.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { keepVersion } from "./note_queries.ts";
import { renderHistory, renderStatuses } from "./render.ts";
import { createNote } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    return test;
};

Deno.test("a local note is a status, with its mentions, hashtags and the note it replies to", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
    });
    const note = await createNote(
        test.ctx,
        "alice",
        {
            visibility: "unlisted",
            content: "Hi @carol@b.example #Verso",
            content_html: "<p>Hi <b>there</b></p>",
            spoiler_text: "Hello",
            sensitive: true,
            language: "en",
            in_reply_to_id: parent.id,
            in_reply_to_account_id: "carol",
        },
        ["carol"],
        ["Verso", "verso"],
    );
    const [alice, carol] = await publicAccounts(test.ctx, ["alice", "carol"]);

    const [status] = await renderStatuses(test.ctx, [{ ...note, replies_count: 2 }], null);
    assertEquals(status, {
        id: note.id,
        uri: `https://social.example/.versia/v0.6/entities/Note/${note.id}`,
        created_at: test.clock.now().toISOString(),
        account: alice,
        content: "<p>Hi <b>there</b></p>",
        visibility: "unlisted",
        sensitive: true,
        spoiler_text: "Hello",
        media_attachments: [],
        mentions: [{ id: "carol", username: "carol", url: carol.uri, acct: "carol@b.example" }],
        tags: [{ name: "verso", url: "https://social.example/tags/verso" }],
        emojis: [],
        reactions: [],
        reblogs_count: 0,
        favourites_count: 0,
        replies_count: 2,
        url: null,
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "carol",
        reblog: null,
        poll: null,
        card: null,
        language: "en",
        text: null,
        edited_at: null,
    });
    assertEquals(Status.safeParse(status).success, true);
});

Deno.test("a remote note is sanitised, and has its instance's id", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
        content_html: '<p onclick="x">Hi</p><script>bad()</script>',
    });

    const [status] = await renderStatuses(test.ctx, [note], "alice");
    assertEquals(
        [status.uri, status.content],
        ["https://b.example/.versia/v0.6/entities/Note/c1", "<p>Hi</p>"],
    );
});

Deno.test("a remote note without its instance's id is a mistake", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example" });

    await assertRejects(() => renderStatuses(test.ctx, [note], null), Error, "has no remote id");
});

Deno.test("a logged-in viewer is told what they did to each, and a redraft is given its text", async () => {
    await using test = await open();
    const first = await createNote(test.ctx, "alice", { content: "First" });
    const second = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c2",
        content: "Second",
    });

    const statuses = await renderStatuses(test.ctx, [second, first], "alice", { source: true });
    assertEquals(statuses.map((status) => [status.id, status.text, status.favourited]), [
        [second.id, "Second", false],
        [first.id, "First", false],
    ]);
    assertEquals(
        [statuses[0].reblogged, statuses[0].muted, statuses[0].bookmarked],
        [false, false, false],
    );
    assertEquals(await renderStatuses(test.ctx, [], null), []);
});

Deno.test("a note's history is what it said before each edit, oldest first, then now", async () => {
    await using test = await open();
    const made = test.clock.now();
    const note = await createNote(test.ctx, "alice", { content_html: "<p>One</p>" });
    const [alice] = await publicAccounts(test.ctx, ["alice"]);
    const version = (content: string, at: Date, spoiler = "", sensitive = false) => ({
        content,
        spoiler_text: spoiler,
        sensitive,
        created_at: at.toISOString(),
        account: alice,
        media_attachments: [],
        emojis: [],
    });

    assertEquals(await renderHistory(test.ctx, note), [version("<p>One</p>", made)]);

    test.clock.advance(1000);
    await keepVersion(test.ctx, note);
    const second = { ...note, content_html: "<p>Two</p>", edited_at: test.clock.now() };
    test.clock.advance(1000);
    await keepVersion(test.ctx, second);
    const third = {
        ...second,
        content_html: "<p>Three</p>",
        spoiler_text: "Numbers",
        sensitive: true,
        edited_at: test.clock.now(),
    };

    const history = await renderHistory(test.ctx, third);
    assertEquals(history, [
        version("<p>One</p>", made),
        version("<p>Two</p>", new Date(made.getTime() + 1000)),
        version("<p>Three</p>", test.clock.now(), "Numbers", true),
    ]);
    assertEquals(StatusEdit.array().safeParse(history).success, true);
});

Deno.test("a remote note's history is sanitised", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
        content_html: '<p onclick="x">Hi</p><script>bad()</script>',
    });
    await keepVersion(test.ctx, note);

    const history = await renderHistory(test.ctx, note);
    assertEquals(history.map((version) => version.content), ["<p>Hi</p>", "<p>Hi</p>"]);
});
