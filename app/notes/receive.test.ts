import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { addEvilInstance, type EvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findRemoteNoteAt, mentionsOf, tagsOf, versionsOf } from "./note_queries.ts";
import { editNote, postNote } from "./notes.ts";
import { removeNote } from "./removal.ts";
import { createNote } from "./testing.ts";
import type { Settings } from "../kernel/settings.ts";
import type { Context } from "../kernel/context.ts";
import { attachedTo } from "../media/attachments.ts";
import { findMedia } from "../media/media_queries.ts";
import type { NoteRow } from "./note_queries.ts";

/** A user served by b.test. */
const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** A public status by bob saying "Hi #Verso", unless `fields` says otherwise. */
const note = (id: string, fields: Record<string, unknown> = {}) => ({
    type: "Note",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    content: {
        "text/plain": { content: "Hi #Verso", remote: false },
        "text/html": { content: "<p>Hi #Verso</p>", remote: false },
    },
    group: "public",
    is_sensitive: false,
    mentions: [],
    attachments: [],
    previews: [],
    ...fields,
});

/**
 * a.test, with alice, and b.test, an instance that sends whatever it is told to, with bob and
 * carol.
 */
const open = async (settings: Partial<Settings> = {}) => {
    const network = await createNetwork(["a.test"], { settings });
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    for (const id of ["bob", "carol"]) b.serve(`/.versia/v0.6/entities/User/${id}`, user(id));

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);

    /** Has `from` send `entity` to a.test, a second after the last, and a.test receive it. */
    const send = async (entity: object, from: EvilInstance = b) => {
        network.clock.advance(1000);
        assertEquals(
            (await from.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** The status b.test has as `remoteId`, as a.test stores it, if it does. */
    const kept = (remoteId: string) => findRemoteNoteAt(a, "b.test", remoteId);

    /** Why a.test gave up on what it was sent, oldest first. */
    const errors = async () =>
        (await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
            .where("last_error", "is not", null).orderBy("created_at").execute())
            .map((job) => job.last_error ?? "");

    const counts = async (id: string) => {
        const row = await findAccount(a, id);
        return [row?.statuses_count, row?.last_status_at?.toISOString()];
    };

    return {
        network,
        a,
        b,
        alice,
        bob,
        send,
        kept,
        errors,
        counts,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a note by someone a local user follows is kept, and counted", async () => {
    await using test = await open();
    await follow(test.a, test.alice, test.bob);
    await test.send({
        type: "FollowAccept",
        author: "bob",
        follower: `a.test:${test.alice}`,
        created_at: "2026-01-01T00:00:00Z",
    });

    await test.send(note("n1"));

    const kept = await test.kept("n1");
    assertEquals(
        [
            kept?.account_id,
            kept?.visibility,
            kept?.content,
            kept?.content_format,
            kept?.content_html,
        ],
        [test.bob, "public", "Hi #Verso", "text/plain", "<p>Hi #Verso</p>"],
    );
    assertEquals(
        [kept?.created_at.toISOString(), kept?.fetched_at, kept?.language, kept?.spoiler_text],
        ["2026-01-01T00:00:00.000Z", test.network.clock.now(), null, ""],
    );
    assertEquals((await tagsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? ""), ["verso"]);
    assertEquals(await test.counts(test.bob), [1, "2026-01-01T00:00:00.000Z"]);
    assertEquals(await test.errors(), []);
});

Deno.test("a note sent unasked is kept only if it mentions or replies to something here", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);

    await test.send(note("n1"));
    await test.send(note("n2", { mentions: ["b.test:carol"] }));
    await test.send(note("n3", { mentions: [`a.test:${test.alice}`, "b.test:carol"] }));
    await test.send(note("n4", { replies_to: `a.test:${local.id}` }));

    assertEquals([await test.kept("n1"), await test.kept("n2")], [undefined, undefined]);
    const mention = await test.kept("n3");
    const carol = await test.a.federation.resolve(test.a, { host: "b.test", id: "carol" }, "User");
    assertEquals(
        (await mentionsOf(test.a, [mention?.id ?? ""])).get(mention?.id ?? ""),
        [test.alice, carol].toSorted(),
    );

    const reply = await test.kept("n4");
    assertEquals([reply?.in_reply_to_id, reply?.in_reply_to_account_id], [local.id, test.alice]);
    const parent = await test.a.db.selectFrom("notes").select("replies_count")
        .where("id", "=", local.id).executeTakeFirstOrThrow();
    assertEquals(parent.replies_count, 1);
    assertEquals(await test.counts(test.bob), [2, "2026-01-01T00:00:00.000Z"]);
});

Deno.test("a note sent unasked that isn't wanted makes Verso fetch nothing it names", async () => {
    await using test = await open();
    test.b.serve("/.versia/v0.6/entities/Note/p1", note("p1"));
    test.b.serve("/.versia/v0.6/entities/User/dave", user("dave"));

    await test.send(
        note("n1", { author: "dave", mentions: ["b.test:carol"], replies_to: "b.test:p1" }),
    );

    assertEquals([await test.kept("n1"), await test.kept("p1")], [undefined, undefined]);
    const fetched = test.network.transport.sent.filter((request) =>
        new URL(request.url).pathname.startsWith("/.versia/v0.6/entities/")
    );
    assertEquals(fetched.map((request) => new URL(request.url).pathname), [
        "/.versia/v0.6/entities/User/bob",
    ]);
    assertEquals(await test.errors(), []);
});

Deno.test("a note does without those it names that can't be had", async () => {
    await using test = await open();

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`, "b.test:nobody", "c.test:dave"],
        replies_to: "b.test:gone",
    }));

    const kept = await test.kept("n1");
    assertEquals((await mentionsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? ""), [test.alice]);
    assertEquals(kept?.in_reply_to_id, null);
});

Deno.test("only a note's first hundred mentions and hashtags are kept", async () => {
    await using test = await open();
    const bea = await createLocalAccount(test.a, "bea");
    const nobody = Array.from({ length: 150 }, (_, i) => `a.test:nobody${i}`);
    const tags = Array.from({ length: 150 }, (_, i) => `#t${i}`).join(" ");

    await test.send(note("n1", {
        content: { "text/plain": { content: tags, remote: false } },
        mentions: [`a.test:${test.alice}`, `a.test:${test.alice}`, ...nobody, `a.test:${bea}`],
    }));

    const kept = await test.kept("n1");
    assertEquals((await mentionsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? ""), [test.alice]);
    const names = (await tagsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? "") ?? [];
    assertEquals([names.length, names.includes("t99"), names.includes("t100")], [100, true, false]);
});

Deno.test("a note mentions as many accounts as settings allow", async () => {
    await using test = await open({ mentions: 1 });
    const bea = await createLocalAccount(test.a, "bea");

    await test.send(note("n1", { mentions: [`a.test:${bea}`, `a.test:${test.alice}`] }));

    const kept = await test.kept("n1");
    assertEquals((await mentionsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? ""), [bea]);
});

/** The media attached to the status b.test has as `remoteId`, in order. */
const attached = async (
    test: { a: Context; kept: (id: string) => Promise<NoteRow | undefined> },
    remoteId: string,
) => {
    const kept = await test.kept(remoteId);
    return await attachedTo(test.a, kept?.id ?? "");
};

Deno.test("a note's files are kept, each as the version clients can best show", async () => {
    await using test = await open();
    const hash = "AB".repeat(32);

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`],
        attachments: [
            {
                "image/heic": { content: "https://b.test/1.heic", remote: true },
                "image/png": {
                    content: "https://b.test/1.png",
                    remote: true,
                    description: "A red square",
                    size: 100,
                    hash,
                    thumbhash: "abc",
                    width: 2,
                    height: 3,
                },
            },
            {
                "video/x-matroska": { content: "https://b.test/2.mkv", remote: true },
                "video/mp4": { content: "https://b.test/2.mp4", remote: true },
            },
            { "image/png": { content: "not a web address", remote: true } },
            { "application/zip": { content: "https://b.test/3.zip", remote: true } },
        ],
    }));

    const files = await attached(test, "n1");
    assertEquals(files.map((row) => [row.url, row.media_type]), [
        ["https://b.test/1.png", "image/png"],
        ["https://b.test/2.mp4", "video/mp4"],
        ["https://b.test/3.zip", "application/zip"],
    ]);
    const [picture] = files;
    assertEquals(
        [picture.size, picture.sha256, picture.thumbhash, picture.width, picture.height],
        [100, hash.toLowerCase(), "abc", 2, 3],
    );
    assertEquals(files.map((row) => row.description), ["A red square", null, null]);
    // On the status's instance, and not an upload by any account.
    const instanceId = (await test.kept("n1"))?.instance_id;
    assertEquals(
        files.map((row) => [row.instance_id, row.account_id]),
        Array(3).fill([instanceId, null]),
    );
});

Deno.test("a note has as many files, described at as much length, as settings allow", async () => {
    await using test = await open({ attachments: 2, mediaDescription: 3 });
    const file = (n: number) => ({
        "image/png": { content: `https://b.test/${n}.png`, remote: true, description: "🎉🎉🎉🎉" },
    });

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`],
        attachments: [file(1), file(2), file(3)],
    }));

    const files = await attached(test, "n1");
    assertEquals(files.map((row) => [row.url, row.description]), [
        ["https://b.test/1.png", "🎉🎉🎉"],
        ["https://b.test/2.png", "🎉🎉🎉"],
    ]);
});

Deno.test("a note's files sent again keep their rows, and a change to them is an edit", async () => {
    await using test = await open();
    const file = (name: string, fields: Record<string, unknown> = {}) => ({
        "image/png": { content: `https://b.test/${name}.png`, remote: true, ...fields },
    });
    const send = (...attachments: object[]) =>
        test.send(note("n1", { mentions: [`a.test:${test.alice}`], attachments }));
    const state = async () => {
        const kept = await test.kept("n1");
        return {
            edited: kept?.edited_at !== null,
            versions: (await versionsOf(test.a, kept?.id ?? "")).map((version) => version.media),
            files: (await attached(test, "n1")).map((row) => [row.id, row.url, row.description]),
        };
    };
    const ids = async () => (await attached(test, "n1")).map((row) => row.id);

    await send(file("a", { description: "A" }), file("b"), file("b"));
    const [a, b1, b2] = await ids();
    await send(file("a", { description: "A", width: 2 }), file("b"), file("b"));

    // Only what it is stored as changed, so it isn't an edit.
    assertEquals(await state(), {
        edited: false,
        versions: [],
        files: [[a, "https://b.test/a.png", "A"], [b1, "https://b.test/b.png", null], [
            b2,
            "https://b.test/b.png",
            null,
        ]],
    });
    assertEquals((await findMedia(test.a, a))?.width, 2);

    await send(file("b"), file("a", { description: "A, again" }), file("c"));
    const [, , c] = await ids();

    assertEquals(await state(), {
        edited: true,
        versions: [[{ id: a, description: "A" }, { id: b1, description: null }, {
            id: b2,
            description: null,
        }]],
        files: [
            [b1, "https://b.test/b.png", null],
            [a, "https://b.test/a.png", "A, again"],
            [c, "https://b.test/c.png", null],
        ],
    });
    // Taken off, but kept until nothing uses it.
    assertEquals((await findMedia(test.a, b2))?.id, b2);
});

Deno.test("any one change to a note's files is an edit, but not to files past the limit", async () => {
    const png = (name: string, description?: string) => ({
        "image/png": { content: `https://b.test/${name}.png`, remote: true, description },
    });
    const sent: [string, object[], boolean][] = [
        ["another file", [png("a"), png("c")], true],
        ["another type", [png("a"), {
            "image/webp": { content: "https://b.test/b.png", remote: true },
        }], true],
        ["another description", [png("a"), png("b", "B")], true],
        ["one fewer", [png("a")], true],
        ["another past the limit", [png("a"), png("b"), png("c")], false],
    ];

    for (const [change, attachments, edit] of sent) {
        await using test = await open({ attachments: 2 });
        const send = (attachments: object[]) =>
            test.send(note("n1", { mentions: [`a.test:${test.alice}`], attachments }));
        await send([png("a"), png("b"), png("d")]);

        await send(attachments);

        assertEquals((await test.kept("n1"))?.edited_at !== null, edit, change);
    }
});

Deno.test("who a note is for, and its warning, are kept as Mastodon has them", async () => {
    await using test = await open();
    const mentioning = { mentions: [`a.test:${test.alice}`] };

    await test.send(note("n1", { ...mentioning, group: "followers", subject: "Food" }));
    await test.send(note("n2", { ...mentioning, group: null, is_sensitive: true }));
    await test.send(note("n3", { ...mentioning, group: "b.test:group" }));

    const kept = [await test.kept("n1"), await test.kept("n2"), await test.kept("n3")];
    assertEquals(kept.map((row) => [row?.visibility, row?.spoiler_text, row?.sensitive]), [
        ["private", "Food", false],
        ["direct", "", true],
        ["direct", "", false],
    ]);
});

Deno.test("a note in Markdown, or only in HTML, keeps what it was written in", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];

    await test.send(note("n1", {
        mentions,
        content: { "text/markdown": { content: "Hi *#Verso*", remote: false } },
    }));
    await test.send(note("n2", {
        mentions,
        content: { "text/html": { content: "<p>Hi</p><p>#Verso</p>", remote: false } },
    }));

    const markdown = await test.kept("n1");
    assertEquals(
        [markdown?.content_format, markdown?.content, markdown?.content_html],
        ["text/markdown", "Hi *#Verso*", "<p>Hi <em>#Verso</em></p>"],
    );
    assertEquals((await tagsOf(test.a, [markdown?.id ?? ""])).get(markdown?.id ?? ""), ["verso"]);

    const html = await test.kept("n2");
    assertEquals([html?.content, html?.content_html], ["", "<p>Hi</p><p>#Verso</p>"]);
    assertEquals((await tagsOf(test.a, [html?.id ?? ""])).get(html?.id ?? ""), ["verso"]);
});

Deno.test("a note sent again replaces the one Verso has, without counting it again", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    await test.send(note("n1", { mentions }));
    const first = await test.kept("n1");

    // No longer mentioning any local user, which only a new status needs to.
    await test.send(note("n1", {
        content: { "text/plain": { content: "Bye #Gone", remote: false } },
        group: "followers",
    }));

    const second = await test.kept("n1");
    assertEquals(
        [second?.id, second?.content, second?.content_html, second?.visibility],
        [first?.id, "Bye #Gone", "<p>Bye #Gone</p>", "private"],
    );
    assertEquals((await mentionsOf(test.a, [first?.id ?? ""])).get(first?.id ?? ""), undefined);
    assertEquals((await tagsOf(test.a, [first?.id ?? ""])).get(first?.id ?? ""), ["gone"]);
    assertEquals(await test.counts(test.bob), [1, "2026-01-01T00:00:00.000Z"]);

    await test.send(note("n1", { author: "carol", mentions }));
    assertEquals((await test.kept("n1"))?.account_id, test.bob);
    assertStringIncludes((await test.errors())[0], "b.test may not give n1 another author");
});

Deno.test("a note sent again is marked edited when it says something else", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    await test.send(note("n1", { mentions }));
    const editedAt = async () => (await test.kept("n1"))?.edited_at?.toISOString();

    await test.send(note("n1", { mentions, group: "followers" }));
    assertEquals(await editedAt(), undefined);

    // Each changes one more thing than the last.
    const changes = [
        {
            content: {
                "text/plain": { content: "Hi #Verso", remote: false },
                "text/html": { content: "<p>Hi <b>#Verso</b></p>", remote: false },
            },
        },
        { content: { "text/plain": { content: "Bye", remote: false } } },
        { content: { "text/markdown": { content: "Bye", remote: false } } },
        { subject: "Spoilers" },
        { is_sensitive: true },
    ];
    let fields = { mentions };
    for (const change of changes) {
        fields = { ...fields, ...change };
        await test.send(note("n1", fields));
        assertEquals(
            await editedAt(),
            test.network.clock.now().toISOString(),
            Object.keys(change)[0],
        );
    }

    const last = test.network.clock.now().toISOString();
    await test.send(note("n1", { ...fields, group: "followers" }));
    assertEquals(await editedAt(), last);

    // What it said before each edit.
    const versions = await versionsOf(test.a, (await test.kept("n1"))?.id ?? "");
    assertEquals(versions.map((version) => [version.content_html, version.spoiler_text]), [
        ["<p>Hi #Verso</p>", ""],
        ["<p>Hi <b>#Verso</b></p>", ""],
        ["<p>Bye</p>", ""],
        ["<p>Bye</p>", ""],
        ["<p>Bye</p>", "Spoilers"],
    ]);
});

Deno.test("a note sent again for others is counted anew", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    const reply = (group: string | null, subject?: string) =>
        note("n1", {
            group,
            subject,
            mentions: [`a.test:${test.alice}`],
            replies_to: `a.test:${local.id}`,
        });
    const counted = async () => [
        (await test.a.db.selectFrom("notes").select("replies_count").where("id", "=", local.id)
            .executeTakeFirstOrThrow()).replies_count,
        (await test.counts(test.bob))[0],
    ];

    await test.send(reply("public"));
    assertEquals(await counted(), [1, 1]);
    await test.send(reply("followers"));
    assertEquals(await counted(), [0, 1]);
    await test.send(reply(null));
    assertEquals(await counted(), [0, 0]);
    // Changed, since the same status sent again would be treated as a replay.
    await test.send(reply("public", "Again"));
    assertEquals(await counted(), [1, 1]);
});

Deno.test("a note by a user who can't be had is given up on", async () => {
    await using test = await open();

    await test.send(note("n1", { author: "nobody", mentions: [`a.test:${test.alice}`] }));

    assertEquals(await test.kept("n1"), undefined);
    assertStringIncludes((await test.errors())[0], "Verso doesn't have nobody");
});

Deno.test("what a reply replies to is fetched, and kept with it", async () => {
    await using test = await open();
    test.b.serve("/.versia/v0.6/entities/Note/n0", note("n0"));

    await test.send(note("n1", { mentions: [`a.test:${test.alice}`], replies_to: "n0" }));

    const parent = await test.kept("n0");
    assertEquals((await test.kept("n1"))?.in_reply_to_id, parent?.id);
    assertEquals(parent?.replies_count, 1);
    assertEquals(
        await test.a.federation.resolve(test.a, { host: "b.test", id: "n0" }, "Note"),
        parent?.id,
    );
});

Deno.test("what a followed author's note, or a kept note sent again, names is fetched", async () => {
    await using test = await open();
    await follow(test.a, test.alice, test.bob);
    await test.send({
        type: "FollowAccept",
        author: "bob",
        follower: `a.test:${test.alice}`,
        created_at: "2026-01-01T00:00:00Z",
    });
    test.b.serve("/.versia/v0.6/entities/Note/n0", note("n0"));
    test.b.serve("/.versia/v0.6/entities/User/dave", user("dave"));

    await test.send(note("n1", { replies_to: "n0" }));
    await test.send(note("n2", { author: "dave", mentions: [`a.test:${test.alice}`] }));
    await test.send(note("n2", { author: "dave", mentions: ["b.test:carol"] }));

    assertEquals((await test.kept("n1"))?.in_reply_to_id, (await test.kept("n0"))?.id);
    const carol = await test.a.federation.resolve(test.a, { host: "b.test", id: "carol" }, "User");
    const edited = await test.kept("n2");
    assertEquals((await mentionsOf(test.a, [edited?.id ?? ""])).get(edited?.id ?? ""), [carol]);
});

Deno.test("what a note quotes is fetched, and kept with it, and quoting a local note is enough", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    test.b.serve("/.versia/v0.6/entities/Note/n0", note("n0"));

    await test.send(note("n1", { mentions: [`a.test:${test.alice}`], quotes: "n0" }));
    await test.send(note("n2", { quotes: `a.test:${local.id}` }));
    await test.send(note("n3", { quotes: "b.test:n0" }));

    const quoted = await test.kept("n0");
    assertEquals((await test.kept("n1"))?.quote_id, quoted?.id);
    assertEquals((await test.kept("n2"))?.quote_id, local.id);
    assertEquals(await test.kept("n3"), undefined);
});

Deno.test("an older note fetched late leaves when its author last posted", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];

    await test.send(note("n2", { mentions, created_at: "2026-01-02T00:00:00Z" }));
    await test.send(note("n1", { mentions }));

    assertEquals(await test.counts(test.bob), [2, "2026-01-02T00:00:00.000Z"]);
});

Deno.test("a note's id has the time it was made, however late it arrived, but none after", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    /** The time `remoteId`'s id has, as a.test keeps it. */
    const idTime = async (remoteId: string) => {
        const hex = (await test.kept(remoteId))?.id.replace("-", "").slice(0, 12) ?? "";
        return new Date(Number.parseInt(hex, 16)).toISOString();
    };

    test.network.clock.advance(60_000);
    const posted = await postNote(test.a, test.alice, {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
    });
    await test.send(note("old", { mentions }));
    await test.send(note("ancient", { mentions, created_at: "1969-12-31T00:00:00Z" }));
    await test.send(note("future", { mentions, created_at: "2030-01-01T00:00:00Z" }));

    assertEquals(await idTime("old"), "2026-01-01T00:00:00.000Z");
    assertEquals(await idTime("ancient"), "1970-01-01T00:00:00.000Z");
    assertEquals(await idTime("future"), test.network.clock.now().toISOString());
    // Before what was posted before it arrived, but after it was made.
    const old = (await test.kept("old"))?.id ?? "";
    assertEquals(old < (posted?.id ?? ""), true);
});

Deno.test("notes with the same id on two instances are two notes", async () => {
    await using test = await open();
    const c = await addEvilInstance(test.network, "c.test");
    c.serve("/.versia/v0.6/entities/User/bob", user("bob"));
    const mentions = [`a.test:${test.alice}`];

    await test.send(note("n1", { mentions }));
    await test.send(
        note("n1", {
            mentions,
            content: { "text/plain": { content: "Elsewhere", remote: false } },
        }),
        c,
    );

    assertEquals((await test.kept("n1"))?.content, "Hi #Verso");
    assertEquals((await findRemoteNoteAt(test.a, "c.test", "n1"))?.content, "Elsewhere");
    assertEquals(
        await test.a.federation.resolve(test.a, { host: "c.test", id: "n1" }, "Note"),
        (await findRemoteNoteAt(test.a, "c.test", "n1"))?.id,
    );
});

Deno.test("a note is found by its reference, here or on its instance", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    await test.send(note("n1", { mentions: [`a.test:${test.alice}`] }));
    const remote = await test.kept("n1");
    const resolve = (host: string, id: string) =>
        test.a.federation.resolve(test.a, { host, id }, "Note");

    assertEquals(await resolve("a.test", local.id), local.id);
    assertEquals(await resolve("a.test", remote?.id ?? ""), undefined);
    assertEquals(await resolve("b.test", "n1"), remote?.id);
    assertEquals(await resolve("b.test", "missing"), undefined);
});

Deno.test("a Delete removes a remote note, and uncounts it", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    await test.send(note("n1", { replies_to: `a.test:${local.id}` }));
    const kept = await test.kept("n1");
    assertExists(kept);

    await test.send({
        type: "Delete",
        author: "bob",
        deleted_type: "Note",
        deleted: "n1",
        created_at: "2026-01-01T00:00:00Z",
    });
    await test.send({
        type: "Delete",
        author: "bob",
        deleted_type: "Note",
        deleted: "n9",
        created_at: "2026-01-01T00:00:00Z",
    });

    assertEquals(await test.kept("n1"), undefined);
    assertEquals((await test.counts(test.bob))[0], 0);
    const parent = await test.a.db.selectFrom("notes").select("replies_count")
        .where("id", "=", local.id).executeTakeFirstOrThrow();
    assertEquals(parent.replies_count, 0);
    assertEquals(await test.errors(), []);
});

Deno.test("a note posted on one Verso reaches the followers on another, edited, until it is deleted", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    const bob = await createLocalAccount(b, "bob");
    const bobOnA = await a.federation.resolve(a, { host: "b.test", id: bob }, "User");
    assertExists(bobOnA);
    await follow(a, alice, bobOnA);
    await network.drain();

    const posted = await postNote(b, bob, {
        text: "Hi @alice@a.test",
        format: "text/plain",
        spoilerText: "",
        visibility: "private",
    });
    assertExists(posted);
    await network.drain();

    const kept = await findRemoteNoteAt(a, "b.test", posted.id);
    assertEquals([kept?.account_id, kept?.visibility, kept?.content], [
        bobOnA,
        "private",
        "Hi @alice@a.test",
    ]);
    assertEquals((await mentionsOf(a, [kept?.id ?? ""])).get(kept?.id ?? ""), [alice]);

    await editNote(b, bob, posted.id, { text: "Bye @alice@a.test" });
    await network.drain();
    const edited = await findRemoteNoteAt(a, "b.test", posted.id);
    assertEquals([edited?.id, edited?.content, edited?.edited_at], [
        kept?.id,
        "Bye @alice@a.test",
        network.clock.now(),
    ]);

    await removeNote(b, posted.id);
    await network.drain();
    assertEquals(await findRemoteNoteAt(a, "b.test", posted.id), undefined);
});
