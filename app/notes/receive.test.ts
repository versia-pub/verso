import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { statusUrl } from "../accounts/render.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { addEvilInstance, type EvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findRemoteNoteAt, mentionsOf, tagsOf, versionsOf } from "./note_queries.ts";
import { editNote, postNote } from "./notes.ts";
import { removeNote } from "./removal.ts";
import { renderStatuses } from "./render.ts";
import { createNote } from "./testing.ts";
import { sanitizerVersion } from "../kernel/html.ts";
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
    manually_approves_subscribers: false,
    indexable: true,
});

/** A public status by bob saying "Hi #Verso", unless `fields` says otherwise. */
const note = (id: string, fields: Record<string, unknown> = {}) => ({
    type: "pub.versia:social/Note",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "b.test:bob",
    content: "<p>Hi #Verso</p>",
    visibility: "public",
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
    for (const id of ["bob", "carol"]) b.serve(`/.versia/v0.7/entities/User/${id}`, user(id));

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);

    /** Has `from` send `entity` to a.test, a second after the last, and a.test receive it. */
    const send = async (entity: object, from: EvilInstance = b) => {
        network.clock.advance(1000);
        assertEquals(
            (await from.send("https://a.test/.versia/v0.7/inbox", { body: entity })).status,
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
        type: "SubscribeAccept",
        subscriber: `a.test:${test.alice}`,
        target: "b.test:bob",
        target_type: "User",
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
        [test.bob, "public", "", "text/plain", "<p>Hi #Verso</p>"],
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
    test.b.serve("/.versia/v0.7/entities/pub.versia:social/Note/p1", note("p1"));
    test.b.serve("/.versia/v0.7/entities/User/dave", user("dave"));

    await test.send(
        note("n1", { author: "b.test:dave", mentions: ["b.test:carol"], replies_to: "b.test:p1" }),
    );

    assertEquals([await test.kept("n1"), await test.kept("p1")], [undefined, undefined]);

    const fetched = test.network.transport.sent.filter((request) =>
        new URL(request.url).pathname.startsWith("/.versia/v0.7/entities/")
    );
    assertEquals(fetched.map((request) => new URL(request.url).pathname), [
        "/.versia/v0.7/entities/User/bob",
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
        content: `<p>${tags}</p>`,
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

Deno.test("a note's files are kept, as they are", async () => {
    await using test = await open();
    const hash = "ab".repeat(32);

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`],
        attachments: [
            {
                url: "https://b.test/1.png",
                media_type: "image/png",
                description: "A red square",
                size: 100,
                hash,
                thumbhash: "abcd",
                width: 2,
                height: 3,
            },
            { url: "https://b.test/2.mp4", media_type: "video/mp4" },
            { url: "https://b.test/3.zip", media_type: "application/zip" },
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
        [picture.size, picture.remote_sha256, picture.thumbhash, picture.width, picture.height],
        [100, hash, "abcd", 2, 3],
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
        url: `https://b.test/${n}.png`,
        media_type: "image/png",
        description: "🎉🎉🎉🎉",
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
        url: `https://b.test/${name}.png`,
        media_type: "image/png",
        ...fields,
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
        url: `https://b.test/${name}.png`,
        media_type: "image/png",
        description,
    });
    const sent: [string, object[], boolean][] = [
        ["another file", [png("a"), png("c")], true],
        [
            "another type",
            [png("a"), { url: "https://b.test/b.png", media_type: "image/webp" }],
            true,
        ],
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

    await test.send(note("n1", { ...mentioning, visibility: "subscribers", subject: "Food" }));
    await test.send(note("n2", { ...mentioning, visibility: "mentions", is_sensitive: true }));
    await test.send(note("n3", { ...mentioning, visibility: "unlisted" }));

    const kept = [await test.kept("n1"), await test.kept("n2"), await test.kept("n3")];
    assertEquals(kept.map((row) => [row?.visibility, row?.spoiler_text, row?.sensitive]), [
        ["private", "Food", false],
        ["direct", "", true],
        ["unlisted", "", false],
    ]);
});

Deno.test("a note's HTML is kept as it is sent, and its hashtags are found in it", async () => {
    await using test = await open();

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`],
        content: "<p>Hi</p><p>#Verso</p>",
    }));

    const kept = await test.kept("n1");
    assertEquals([kept?.content, kept?.content_html], ["", "<p>Hi</p><p>#Verso</p>"]);
    assertEquals((await tagsOf(test.a, [kept?.id ?? ""])).get(kept?.id ?? ""), ["verso"]);
});

Deno.test("a note sent again replaces the one Verso has, without counting it again", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    await test.send(note("n1", { mentions }));
    const first = await test.kept("n1");

    // No longer mentioning any local user, which only a new status needs to.
    await test.send(note("n1", {
        content: "<p>Bye #Gone</p>",
        visibility: "subscribers",
    }));

    const second = await test.kept("n1");
    assertEquals(
        [second?.id, second?.content, second?.content_html, second?.visibility],
        [first?.id, "", "<p>Bye #Gone</p>", "private"],
    );
    assertEquals((await mentionsOf(test.a, [first?.id ?? ""])).get(first?.id ?? ""), undefined);
    assertEquals((await tagsOf(test.a, [first?.id ?? ""])).get(first?.id ?? ""), ["gone"]);
    assertEquals(await test.counts(test.bob), [1, "2026-01-01T00:00:00.000Z"]);

    await test.send(note("n1", { author: "b.test:carol", mentions }));
    assertEquals((await test.kept("n1"))?.account_id, test.bob);
    assertStringIncludes((await test.errors())[0], "b.test may not give n1 another author");
});

Deno.test("a note sent again is marked edited when it says something else", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    await test.send(note("n1", { mentions }));
    const editedAt = async () => (await test.kept("n1"))?.edited_at?.toISOString();

    await test.send(note("n1", { mentions, visibility: "subscribers" }));
    assertEquals(await editedAt(), undefined);

    // Each changes one more thing than the last.
    const changes = [
        { content: "<p>Hi <b>#Verso</b></p>" },
        { content: "<p>Bye</p>" },
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
    await test.send(note("n1", { ...fields, visibility: "subscribers" }));
    assertEquals(await editedAt(), last);

    // What it said before each edit.
    const versions = await versionsOf(test.a, (await test.kept("n1"))?.id ?? "");
    assertEquals(versions.map((version) => [version.content_html, version.spoiler_text]), [
        ["<p>Hi #Verso</p>", ""],
        ["<p>Hi <b>#Verso</b></p>", ""],
        ["<p>Bye</p>", ""],
        ["<p>Bye</p>", "Spoilers"],
    ]);
});

Deno.test("a note's HTML is sanitised, and kept unsanitised before, isn't edited by being sent again", async () => {
    await using test = await open();
    const unsafe = '<p onclick="x">Hi #Verso</p><script>bad()</script>';
    const sent = note("n1", {
        mentions: [`a.test:${test.alice}`],
        content: unsafe,
    });
    await test.send(sent);
    const kept = await test.kept("n1");
    assertEquals(
        [kept?.content_html, kept?.html_version],
        ["<p>Hi #Verso</p>", sanitizerVersion],
    );

    await test.a.db.updateTable("notes")
        .set({ content_html: unsafe, html_version: 0 })
        .where("id", "=", kept?.id ?? "")
        .execute();
    await test.send(sent);

    const again = await test.kept("n1");
    assertEquals(
        [again?.content_html, again?.html_version, again?.edited_at],
        ["<p>Hi #Verso</p>", sanitizerVersion, null],
    );
    assertEquals(await versionsOf(test.a, kept?.id ?? ""), []);
});

Deno.test("a note sent again for others is counted anew", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    const reply = (visibility: string, subject?: string) =>
        note("n1", {
            visibility,
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
    await test.send(reply("subscribers"));
    assertEquals(await counted(), [0, 1]);
    await test.send(reply("mentions"));
    assertEquals(await counted(), [0, 0]);
    // Changed, since the same status sent again would be treated as a replay.
    await test.send(reply("public", "Again"));
    assertEquals(await counted(), [1, 1]);
});

Deno.test("a note by a user who can't be had is given up on", async () => {
    await using test = await open();

    await test.send(note("n1", { author: "b.test:nobody", mentions: [`a.test:${test.alice}`] }));

    assertEquals(await test.kept("n1"), undefined);
    assertStringIncludes((await test.errors())[0], "Verso doesn't have b.test:nobody");
});

Deno.test("what a reply replies to is fetched, and kept with it", async () => {
    await using test = await open();
    test.b.serve("/.versia/v0.7/entities/pub.versia:social/Note/n0", note("n0"));

    await test.send(note("n1", { mentions: [`a.test:${test.alice}`], replies_to: "b.test:n0" }));

    const parent = await test.kept("n0");
    assertEquals((await test.kept("n1"))?.in_reply_to_id, parent?.id);
    assertEquals(parent?.replies_count, 1);
    assertEquals(
        await test.a.federation.resolve(
            test.a,
            { host: "b.test", id: "n0" },
            "pub.versia:social/Note",
        ),
        parent?.id,
    );
});

Deno.test("what a followed author's note, or a kept note sent again, names is fetched", async () => {
    await using test = await open();
    await follow(test.a, test.alice, test.bob);
    await test.send({
        type: "SubscribeAccept",
        subscriber: `a.test:${test.alice}`,
        target: "b.test:bob",
        target_type: "User",
        created_at: "2026-01-01T00:00:00Z",
    });
    test.b.serve("/.versia/v0.7/entities/pub.versia:social/Note/n0", note("n0"));
    test.b.serve("/.versia/v0.7/entities/User/dave", user("dave"));

    await test.send(note("n1", { replies_to: "b.test:n0" }));
    await test.send(note("n2", { author: "b.test:dave", mentions: [`a.test:${test.alice}`] }));
    await test.send(note("n2", { author: "b.test:dave", mentions: ["b.test:carol"] }));

    assertEquals((await test.kept("n1"))?.in_reply_to_id, (await test.kept("n0"))?.id);

    const carol = await test.a.federation.resolve(test.a, { host: "b.test", id: "carol" }, "User");
    const edited = await test.kept("n2");
    assertEquals((await mentionsOf(test.a, [edited?.id ?? ""])).get(edited?.id ?? ""), [carol]);
});

Deno.test("what a note quotes is fetched, and kept with it, and quoting a local note is enough", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    test.b.serve("/.versia/v0.7/entities/pub.versia:social/Note/n0", note("n0"));

    await test.send(note("n1", { mentions: [`a.test:${test.alice}`], quoting: "b.test:n0" }));
    await test.send(note("n2", { quoting: `a.test:${local.id}` }));
    await test.send(note("n3", { quoting: "b.test:n0" }));

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
        // An id is base32, with its time in milliseconds above the low 48 bits.
        const id = (await test.kept(remoteId))?.id ?? "";
        const value = [...id].reduce(
            (number, char) =>
                number * 32n + BigInt("0123456789abcdefghjkmnpqrstvwxyz".indexOf(char)),
            0n,
        );
        return new Date(Number(value >> 48n)).toISOString();
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
    c.serve("/.versia/v0.7/entities/User/bob", user("bob"));
    const mentions = [`a.test:${test.alice}`];

    await test.send(note("n1", { mentions }));
    await test.send(
        note("n1", {
            mentions,
            author: "c.test:bob",
            content: "<p>Elsewhere</p>",
        }),
        c,
    );

    assertEquals((await test.kept("n1"))?.content_html, "<p>Hi #Verso</p>");
    assertEquals(
        (await findRemoteNoteAt(test.a, "c.test", "n1"))?.content_html,
        "<p>Elsewhere</p>",
    );
    assertEquals(
        await test.a.federation.resolve(
            test.a,
            { host: "c.test", id: "n1" },
            "pub.versia:social/Note",
        ),
        (await findRemoteNoteAt(test.a, "c.test", "n1"))?.id,
    );
});

Deno.test("a note is found by its reference, here or on its instance", async () => {
    await using test = await open();
    const local = await createNote(test.a, test.alice);
    await test.send(note("n1", { mentions: [`a.test:${test.alice}`] }));
    const remote = await test.kept("n1");
    const resolve = (host: string, id: string) =>
        test.a.federation.resolve(test.a, { host, id }, "pub.versia:social/Note");

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
        deleted_type: "pub.versia:social/Note",
        deleted: "n1",
        created_at: "2026-01-01T00:00:00Z",
    });
    await test.send({
        type: "Delete",
        author: "bob",
        deleted_type: "pub.versia:social/Note",
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
    assertEquals([kept?.account_id, kept?.visibility], [bobOnA, "private"]);
    assertStringIncludes(kept?.content_html ?? "", "Hi ");
    assertEquals((await mentionsOf(a, [kept?.id ?? ""])).get(kept?.id ?? ""), [alice]);

    await editNote(b, bob, posted.id, { text: "Bye @alice@a.test" });
    await network.drain();
    const edited = await findRemoteNoteAt(a, "b.test", posted.id);
    assertEquals([edited?.id, edited?.edited_at], [kept?.id, network.clock.now()]);
    assertStringIncludes(edited?.content_html ?? "", "Bye ");

    await removeNote(b, posted.id);
    await network.drain();
    assertEquals(await findRemoteNoteAt(a, "b.test", posted.id), undefined);
});

Deno.test("a note's url is kept, unless it is too long to store", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];

    await test.send(note("n1", { mentions, url: "https://b.test/@bob/1" }));
    await test.send(note("n2", { mentions, url: `https://b.test/${"a".repeat(2048)}` }));
    await test.send(note("n3", { mentions }));

    assertEquals((await test.kept("n1"))?.url, "https://b.test/@bob/1");
    assertEquals((await test.kept("n2"))?.url, null);
    assertEquals((await test.kept("n3"))?.url, null);

    await test.send(note("n1", { mentions, url: "https://b.test/@bob/one" }));
    assertEquals((await test.kept("n1"))?.url, "https://b.test/@bob/one");
});

Deno.test("a note's url is its status's url, or else its page here", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    await test.send(note("n1", { mentions, url: "https://b.test/@bob/1" }));
    await test.send(note("n2", { mentions }));
    const [given, none] = [await test.kept("n1"), await test.kept("n2")];
    assertExists(given);
    assertExists(none);
    const author = await findAccount(test.a, none.account_id);
    assertExists(author);

    const statuses = await renderStatuses(test.a, [given, none], null);

    assertEquals(statuses.map((status) => status.url), [
        "https://b.test/@bob/1",
        statusUrl(test.a, author, none.id),
    ]);
});

Deno.test("a version of a note with an older updated_at, or another created_at, is discarded", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    const sent = (fields: Record<string, unknown>) =>
        test.send(note("n1", { mentions, ...fields }));
    const html = async () => (await test.kept("n1"))?.content_html;

    await sent({ updated_at: "2026-01-02T00:00:00Z", content: "<p>Two</p>" });
    await sent({ updated_at: "2026-01-01T12:00:00Z", content: "<p>One</p>" });
    assertEquals(await html(), "<p>Two</p>");

    await sent({ updated_at: "2026-01-03T00:00:00Z", created_at: "2026-01-01T00:00:01Z" });
    await sent({ updated_at: "2026-01-03T00:00:00Z", content: "<p>Three</p>" });
    assertEquals(await html(), "<p>Three</p>");
    assertEquals((await test.kept("n1"))?.updated_at?.toISOString(), "2026-01-03T00:00:00.000Z");
});

Deno.test("a note is edited at its updated_at, but not before it was created or after now", async () => {
    await using test = await open();
    const mentions = [`a.test:${test.alice}`];
    const sent = (content: string, updated_at?: string) =>
        test.send(note("n1", { mentions, content: `<p>${content}</p>`, updated_at }));
    const editedAt = async () => (await test.kept("n1"))?.edited_at?.toISOString();
    await sent("One");

    await sent("Two", "2025-12-31T00:00:00Z");
    assertEquals(await editedAt(), "2026-01-01T00:00:00.000Z");

    const earlier = new Date(test.network.clock.now().getTime() - 500).toISOString();
    await sent("Three", earlier);
    assertEquals(await editedAt(), earlier);

    await sent("Four", "2030-01-01T00:00:00Z");
    assertEquals(await editedAt(), test.network.clock.now().toISOString());
});

Deno.test("a mention in a note links to the user's page here, and one of someone unknown stays as sent", async () => {
    await using test = await open();
    const link = (href: string, reference: string) =>
        `<a href="${href}" data-mention="${reference}">@x</a>`;

    await test.send(note("n1", {
        mentions: [`a.test:${test.alice}`],
        content: `<p>${link("https://evil.test/@alice", `a.test:${test.alice}`)} ` +
            `${link("https://evil.test/@x", "b.test:nobody")} ` +
            `${link("https://evil.test/@y", "not a reference")}</p>`,
    }));

    const content = (await test.kept("n1"))?.content_html ?? "";
    assertStringIncludes(content, 'href="https://a.test/@alice" data-mention="');
    assertStringIncludes(content, 'href="https://evil.test/@x" data-mention="b.test:nobody"');
    assertEquals(content.includes("evil.test/@alice"), false);
    assertEquals(content.includes("not a reference"), false);
});
