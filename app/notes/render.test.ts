import { assertEquals, assertRejects } from "@std/assert";
import { Status, StatusEdit } from "@versia/client-api";
import { publicAccounts } from "../accounts/public.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createFilter } from "../filters/filters.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { like } from "../interactions/likes.ts";
import { react } from "../interactions/reactions.ts";
import { sanitizerVersion } from "../kernel/html.ts";
import { pollOf } from "../polls/poll_queries.ts";
import { addPoll, vote } from "../polls/polls.ts";
import { createTestContext } from "../testing/context.ts";
import { bookmark } from "./bookmarks.ts";
import { findNote, keepVersion } from "./note_queries.ts";
import { pin } from "./pins.ts";
import { renderHistory, renderStatuses, renderStatusesFor } from "./render.ts";
import { createNote, createShare } from "./testing.ts";
import { setThreadMuted } from "./thread_mutes.ts";

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
    const [alice] = await publicAccounts(test.ctx, ["alice"]);

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
        mentions: [{
            id: "carol",
            username: "carol",
            url: "https://social.example/@carol@b.example",
            acct: "carol@b.example",
        }],
        tags: [{ name: "Verso", url: "https://social.example/tags/verso" }],
        emojis: [],
        reactions: [],
        reblogs_count: 0,
        favourites_count: 0,
        replies_count: 2,
        url: `https://social.example/@alice/${note.id}`,
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "carol",
        reblog: null,
        quote: null,
        quote_approval: { automatic: ["public"], manual: [], current_user: "denied" },
        quotes_count: 0,
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
        [status.uri, status.url, status.content],
        [
            "https://b.example/.versia/v0.6/entities/Note/c1",
            `https://social.example/@carol@b.example/${note.id}`,
            "<p>Hi</p>",
        ],
    );
});

Deno.test("a boost has no page of its own, so its url is its uri", async () => {
    await using test = await open();
    const posted = await createNote(test.ctx, "alice");
    const local = await createShare(test.ctx, "alice", posted.id);
    const remote = await createShare(test.ctx, "carol", posted.id, {
        instance_id: "b.example",
        remote_id: "s",
    });

    const statuses = await renderStatuses(test.ctx, [local, remote], null);
    assertEquals(statuses.map((status) => [status.uri, status.url, status.reblog?.url]), [
        [
            `https://social.example/.versia/v0.6/entities/pub.versia%3Ashare%2FShare/${local.id}`,
            `https://social.example/.versia/v0.6/entities/pub.versia%3Ashare%2FShare/${local.id}`,
            `https://social.example/@alice/${posted.id}`,
        ],
        [
            "https://b.example/.versia/v0.6/entities/Note/s",
            "https://b.example/.versia/v0.6/entities/Note/s",
            `https://social.example/@alice/${posted.id}`,
        ],
    ]);
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

Deno.test("statuses rendered for many viewers at once are as each sees them alone", async () => {
    await using test = await open();
    for (const id of ["bob", "dave", "erin", "frank", "grace"]) {
        await createLocalAccount(test.ctx, id);
    }
    const posted = await createNote(test.ctx, "alice", {
        content: "Hello there",
        content_html: "<p>Hello there</p>",
    });
    await addPoll(test.ctx, posted.id, {
        options: ["Red", "Blue"],
        expiresIn: 3600,
        multiple: false,
        hideTotals: false,
    });
    await vote(test.ctx, "bob", (await pollOf(test.ctx, posted.id))?.id ?? "", [0]);
    await pin(test.ctx, "alice", posted.id);
    for (const by of ["bob", "frank"]) await like(test.ctx, by, posted.id);
    await createShare(test.ctx, "bob", posted.id);
    await createShare(test.ctx, "carol", posted.id, { instance_id: "b.example", remote_id: "s" });
    await bookmark(test.ctx, "bob", posted.id);
    await react(test.ctx, "bob", posted.id, "👍");
    for (const emoji of ["👍", "🎉"]) await react(test.ctx, "frank", posted.id, emoji);
    await setThreadMuted(test.ctx, "bob", posted.id, true);
    await createFilter(test.ctx, "bob", {
        title: "Greetings",
        context: ["home"],
        action: "warn",
        expiresIn: null,
    }, [{ keyword: "hello", whole_word: true }]);
    // dave doesn't see frank's like and reactions, nor erin carol's boost.
    await block(test.ctx, "dave", "frank");
    await blockDomainFor(test.ctx, "erin", "b.example");
    // Only frank, who follows grace, may see her private status, boosted and quoted.
    await follow(test.ctx, "frank", "grace");
    const secret = await createNote(test.ctx, "grace", { visibility: "private" });
    const boost = await createShare(test.ctx, "grace", secret.id);
    const quoting = await createNote(test.ctx, "bob", { quote_id: secret.id });
    const note = await findNote(test.ctx, posted.id);
    if (note === undefined) throw new Error("No note");

    const notes = [note, boost, quoting];
    const viewers = ["alice", "bob", "dave", "erin", "frank", null];
    const together = await renderStatusesFor(test.ctx, notes, viewers);
    for (const viewer of viewers) {
        assertEquals(together.get(viewer), await renderStatuses(test.ctx, notes, viewer));
    }

    const shown = (viewer: string | null) => together.get(viewer)?.[0];
    assertEquals(viewers.map((viewer) => shown(viewer)?.favourited), [
        false,
        true,
        false,
        false,
        true,
        undefined,
    ]);
    assertEquals(
        [shown("bob")?.reblogged, shown("bob")?.bookmarked, shown("bob")?.muted],
        [true, true, true],
    );
    assertEquals([shown("alice")?.pinned, shown("bob")?.pinned], [true, undefined]);
    assertEquals(
        [shown("bob")?.poll?.voted, shown("erin")?.poll?.voted, shown(null)?.poll?.voted],
        [true, false, undefined],
    );
    assertEquals(
        viewers.map((viewer) => [
            shown(viewer)?.favourites_count,
            shown(viewer)?.reblogs_count,
            shown(viewer)?.reactions?.map((reaction) => [reaction.name, reaction.count]),
        ]),
        [
            [2, 2, [["👍", 2], ["🎉", 1]]],
            [2, 2, [["👍", 2], ["🎉", 1]]],
            [1, 2, [["👍", 1]]],
            [2, 1, [["👍", 2], ["🎉", 1]]],
            [2, 2, [["👍", 2], ["🎉", 1]]],
            [2, 2, [["👍", 2], ["🎉", 1]]],
        ],
    );
    assertEquals(shown("bob")?.reactions?.map((reaction) => reaction.me), [true, false]);
    assertEquals(shown("frank")?.reactions?.map((reaction) => reaction.me), [true, true]);
    assertEquals(
        viewers.map((viewer) => shown(viewer)?.filtered?.map((result) => result.filter.title)),
        [[], ["Greetings"], [], [], [], undefined],
    );
    assertEquals(
        viewers.map((viewer) => together.get(viewer)?.map((status) => status.id)),
        viewers.map((viewer) =>
            viewer === "frank" || viewer === "grace"
                ? [note.id, boost.id, quoting.id]
                : [note.id, quoting.id]
        ),
    );
    const quote = (viewer: string) => together.get(viewer)?.at(-1)?.quote;
    assertEquals(quote("frank"), {
        state: "accepted",
        quoted_status: together.get("frank")?.[1].reblog ?? null,
    });
    assertEquals(quote("erin"), { state: "unauthorized", quoted_status: null });
});

Deno.test("a viewer isn't counted the reactions of those they block, who did nothing else", async () => {
    await using test = await open();
    for (const id of ["bob", "dave"]) await createLocalAccount(test.ctx, id);
    const note = await createNote(test.ctx, "alice");
    await react(test.ctx, "bob", note.id, "👍");
    await block(test.ctx, "dave", "bob");

    const shown = await renderStatusesFor(test.ctx, [note], ["alice", "dave"]);

    assertEquals(
        ["alice", "dave"].map((viewer) =>
            shown.get(viewer)?.[0].reactions?.map((reaction) => [reaction.name, reaction.count])
        ),
        [[["👍", 1]], []],
    );
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

Deno.test("a remote note's HTML, sanitised when it was stored, is shown as it is", async () => {
    await using test = await open();
    // Not as this sanitiser would leave it, to show it isn't sanitised again.
    const stored = '<p onclick="x">Hi</p>';
    const note = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
        content_html: stored,
        html_version: sanitizerVersion,
    });
    await keepVersion(test.ctx, note);

    const [status] = await renderStatuses(test.ctx, [note], null);
    const history = await renderHistory(test.ctx, note);
    assertEquals([status.content, ...history.map((version) => version.content)], [
        stored,
        stored,
        stored,
    ]);
});
