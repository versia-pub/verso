import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { findRemoteNoteAt, versionsOf } from "../notes/note_queries.ts";
import { postNote } from "../notes/notes.ts";
import { renderVersiaNotes } from "../notes/versia.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { createTestContext } from "../testing/context.ts";
import { endPolls } from "./ending.ts";
import { pollOf, votesAmong } from "./poll_queries.ts";
import { vote } from "./polls.ts";

const text = (content: string) => ({ "text/plain": { content, remote: false } });

Deno.test("polls are an extension Verso supports", () => {
    assertEquals(registry.extensions.includes("pub.versia:polls"), true);
});

Deno.test("a local poll is in its Note, with its counts hidden until it ends if it hides them", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const ask = async (hideTotals: boolean) => {
        const note = await postNote(test.ctx, "alice", {
            text: "Which?",
            format: "text/plain",
            spoilerText: "",
            poll: { options: ["Red", "Blue"], expiresIn: 3600, multiple: hideTotals, hideTotals },
        });
        assertExists(note);

        const poll = await pollOf(test.ctx, note.id);
        await vote(test.ctx, "bob", poll?.id ?? "", [1]);
        return note;
    };
    const shown = await ask(false);
    const hidden = await ask(true);
    const extensions = async () =>
        (await renderVersiaNotes(test.ctx, [shown, hidden])).map((note) => note.extensions);

    const expiresAt = new Date(test.clock.now().getTime() + 3600_000).toISOString();
    const poll = (votes: number[], multiple: boolean) => ({
        "pub.versia:polls": {
            options: [text("Red"), text("Blue")],
            votes,
            multiple_choice: multiple,
            expires_at: expiresAt,
        },
    });
    assertEquals(await extensions(), [poll([0, 1], false), poll([0, 0], true)]);

    test.clock.advance(3600_000);
    assertEquals(await extensions(), [poll([0, 1], false), poll([0, 1], true)]);
});

/** A public status by bob on b.test, which mentions alice, with the poll `fields` give. */
const note = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "Note",
    id: "n1",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    content: text("Which?"),
    group: "public",
    is_sensitive: false,
    mentions: ["a.test:alice"],
    attachments: [],
    previews: [],
    extensions: {
        "pub.versia:polls": {
            options: [text("Red"), text("Blue")],
            votes: [3, 4],
            multiple_choice: false,
            ...fields,
        },
    },
    ...extra,
});

/** a.test, with alice and dave, and b.test, an instance that sends whatever it is told to. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", {
        type: "User",
        id: "bob",
        created_at: "2026-01-01T00:00:00Z",
        username: "bob",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });
    for (const id of ["alice", "dave"]) await createLocalAccount(a, id);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test receive it. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        await b.send("https://a.test/.versia/v0.6/inbox", { body: entity });
        await network.drain();
    };

    const kept = async () => {
        const row = await findRemoteNoteAt(a, "b.test", "n1");
        assertExists(row);
        return row;
    };

    /** Its poll's options and counts, how many voted, and whether it is multiple choice. */
    const asked = async () => {
        const poll = await pollOf(a, (await kept()).id);
        return poll && {
            options: poll.options.map((option) => [option.title, option.votes_count]),
            voters: poll.voters_count,
            multiple: poll.multiple,
            hidden: poll.hide_totals,
            expiresAt: poll.expires_at?.toISOString(),
        };
    };

    return { network, a, send, kept, asked, [Symbol.asyncDispose]: network[Symbol.asyncDispose] };
};

Deno.test("a remote poll is kept with its counts, but not who voted", async () => {
    await using test = await open();

    await test.send(note({ expires_at: "2026-02-01T00:00:00Z" }));

    assertEquals(await test.asked(), {
        options: [["Red", 3], ["Blue", 4]],
        voters: null,
        multiple: false,
        hidden: false,
        expiresAt: "2026-02-01T00:00:00.000Z",
    });
});

Deno.test("a remote poll's options may be HTML, and those without counts have no votes", async () => {
    await using test = await open();
    // Text that is remote is a link to it, which isn't fetched.
    const html = {
        "text/plain": { content: "https://b.test/option.txt", remote: true },
        "text/html": { content: "<p>Light <b>blue</b></p>", remote: false },
    };
    const options = [...Array(101).keys()].map((index) => text(` Option ${index} `));

    await test.send(note({ options: [html, ...options], votes: [5], multiple_choice: true }));

    const asked = await test.asked();
    assertEquals(asked?.options.slice(0, 3), [["Light blue", 5], ["Option 0", 0], [
        "Option 1",
        0,
    ]]);
    assertEquals(asked?.options.length, 100);
    assertEquals([asked?.multiple, asked?.expiresAt], [true, undefined]);
});

Deno.test("a poll that isn't as Versia defines it, or has no options, is no poll", async () => {
    await using test = await open();

    for (const fields of [{ options: [] }, { votes: [-1, 0] }, { multiple_choice: "no" }]) {
        await test.send(note(fields));
        assertEquals(await test.asked(), undefined, JSON.stringify(fields));
    }
});

Deno.test("a remote poll sent again with new counts isn't edited, and keeps local votes", async () => {
    await using test = await open();
    await test.send(note({}));
    const poll = await pollOf(test.a, (await test.kept()).id);
    await vote(test.a, "alice", poll?.id ?? "", [0]);

    await test.send(note({ votes: [8, 4] }));

    assertEquals((await test.asked())?.options, [["Red", 8], ["Blue", 4]]);
    assertEquals((await test.kept()).edited_at, null);
    assertEquals(
        await votesAmong(test.a, ["alice"], [poll?.id ?? ""]),
        new Map([["alice", new Map([[poll?.id ?? "", [0]]])]]),
    );
});

Deno.test("a remote poll that asks something else, or is removed, is an edit", async () => {
    await using test = await open();
    await test.send(note({}));
    const poll = await pollOf(test.a, (await test.kept()).id);
    await vote(test.a, "alice", poll?.id ?? "", [0]);

    await test.send(note({ options: [text("Red"), text("Green")], votes: [0, 1] }));
    assertEquals((await test.kept()).edited_at, test.network.clock.now());
    assertEquals((await test.asked())?.options, [["Red", 0], ["Green", 1]]);
    assertEquals(await votesAmong(test.a, ["alice"], [poll?.id ?? ""]), new Map());

    await test.send(note({ options: [text("Red"), text("Green")], multiple_choice: true }));
    assertEquals((await test.kept()).edited_at, test.network.clock.now());

    await test.send(note({}, { extensions: undefined }));
    assertEquals((await test.kept()).edited_at, test.network.clock.now());
    assertEquals(await test.asked(), undefined);

    await test.send(note({}));
    assertEquals((await test.kept()).edited_at, test.network.clock.now());

    const versions = await versionsOf(test.a, (await test.kept()).id);
    assertEquals(versions.map((version) => version.poll_options), [
        ["Red", "Blue"],
        ["Red", "Green"],
        ["Red", "Green"],
        null,
    ]);
});

Deno.test("a remote poll that ended, sent again, doesn't end again", async () => {
    await using test = await open();
    const expiresAt = new Date(test.network.clock.now().getTime() + 60_000);
    const asked = note({ expires_at: expiresAt.toISOString() });
    await test.send(asked);
    const poll = await pollOf(test.a, (await test.kept()).id);
    await vote(test.a, "dave", poll?.id ?? "", [1]);
    const notified = async () =>
        (await test.a.db.selectFrom("notifications").select("account_id")
            .where("type", "=", "poll")
            .execute()).map((row) => row.account_id);

    test.network.clock.advance(60_000);
    await endPolls(test.a);
    await test.send(note({ expires_at: expiresAt.toISOString(), votes: [3, 5] }));
    await endPolls(test.a);
    assertEquals(await notified(), ["dave"]);

    // An end that moves is a new one.
    await test.send(note({ expires_at: new Date(expiresAt.getTime() + 1).toISOString() }));
    await endPolls(test.a);
    assertEquals(await notified(), ["dave", "dave"]);
});
