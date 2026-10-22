import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { findNote } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";

/** A user b.test serves. */
const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** bob's Reaction to the note `object` with `content`, and the emojis of `extensions`. */
const reaction = (id: string, object: string, content: string, extensions?: object) => ({
    type: "pub.versia:reactions/Reaction",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    object,
    content,
    extensions,
});

/** The extension for b.test's emoji `shortcode`, with its picture at `<shortcode>.png`. */
const emoji = (shortcode: string) => ({
    "pub.versia:custom_emojis": {
        emojis: [{
            name: `:${shortcode}:`,
            content: { "image/png": { content: `https://b.test/${shortcode}.png`, remote: true } },
        }],
    },
});

/** bob's Delete of his reaction `id`. */
const undo = (id: string) => ({
    type: "Delete",
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    deleted_type: "pub.versia:reactions/Reaction",
    deleted: id,
});

/** a.test, with alice and her note, and b.test, which sends what it is told, with bob. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", user("bob"));

    const alice = await createLocalAccount(a, "alice");
    const local = await createNote(a, alice);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test take it in. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** The reactions to the note `noteId`, as alice is shown them, with the emojis they use. */
    const shown = async (noteId: string) => {
        const note = await findNote(a, noteId);
        if (note === undefined) throw new Error(`There is no note ${noteId}`);
        const [status] = await renderStatuses(a, [note], alice);
        return {
            reactions: status?.reactions,
            emojis: status?.emojis.map((each) => [each.shortcode, each.url]),
        };
    };

    /** How many reactions a.test keeps, to any note. */
    const kept = async () => (await a.db.selectFrom("reactions").select("id").execute()).length;

    /** Why a.test gave up on what it was sent, oldest first. */
    const errors = async () =>
        (await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
            .where("last_error", "is not", null).orderBy("created_at").execute())
            .map((job) => job.last_error ?? "");

    return {
        network,
        a,
        alice,
        local,
        send,
        shown,
        kept,
        errors,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a reaction to a local note is kept, once, and a Delete undoes it", async () => {
    await using test = await open();

    await test.send(reaction("r1", `a.test:${test.local.id}`, "🎉"));
    await test.send(reaction("r1", `a.test:${test.local.id}`, "🎉"));
    assertEquals(await test.shown(test.local.id), {
        reactions: [{ name: "🎉", count: 1, remote: false, me: false }],
        emojis: [],
    });

    // It is kept as made then.
    assertEquals(
        (await test.a.db.selectFrom("reactions").select("created_at").executeTakeFirst())
            ?.created_at.toISOString(),
        "2026-01-01T00:00:00.000Z",
    );

    // Another id for the same reaction is the same reaction.
    await test.send(reaction("r2", `a.test:${test.local.id}`, "🎉"));
    assertEquals(await test.kept(), 1);

    await test.send(undo("r2"));
    assertEquals(await test.kept(), 1);
    // Another instance can't undo it, though its own reaction has that id.
    const c = await addEvilInstance(test.network, "c.test");
    c.serve("/.versia/v0.6/entities/User/bob", user("bob"));
    assertEquals(
        (await c.send("https://a.test/.versia/v0.6/inbox", { body: undo("r1") })).status,
        202,
    );
    await test.network.drain();
    assertEquals(await test.kept(), 1);

    await test.send(undo("r1"));
    assertEquals(await test.kept(), 0);
    assertEquals(await test.errors(), []);
});

Deno.test("a reaction with the sender's custom emoji is kept with it", async () => {
    await using test = await open();

    await test.send(reaction("r1", `a.test:${test.local.id}`, ":blob:", emoji("blob")));
    assertEquals(await test.shown(test.local.id), {
        reactions: [{ name: ":blob@b.test:", count: 1, remote: true, me: false }],
        emojis: [["blob@b.test", "https://b.test/blob.png"]],
    });

    // Undone, its emoji is kept, as others may use it.
    await test.send(undo("r1"));
    assertEquals(await test.kept(), 0);
    assertEquals(
        (await test.a.db.selectFrom("emojis").select("shortcode").where(
            "instance_id",
            "is not",
            null,
        )
            .execute()).map((row) => row.shortcode),
        ["blob"],
    );
});

Deno.test("a reaction Verso can't show, or to a note it doesn't have, is dropped", async () => {
    await using test = await open();
    const share = await createShare(test.a, test.alice, test.local.id);
    const object = `a.test:${test.local.id}`;

    for (
        const each of [
            reaction("r1", object, "nice"),
            reaction("r2", object, ":blob:"),
            reaction("r3", object, ":blob:", emoji("cat")),
            reaction("r4", object, "x:blob:", emoji("blob")),
            reaction("r5", "a.test:missing", "🎉"),
            reaction("r6", `a.test:${share.id}`, "🎉"),
            reaction("r7", "b.test:n1", "🎉"),
        ]
    ) {
        await test.send(each);
    }

    assertEquals(await test.kept(), 0);
    assertEquals(await test.errors(), []);
    // Its author wasn't fetched for it.
    assertEquals(
        (await test.a.db.selectFrom("accounts").select("id").where("remote_id", "=", "bob")
            .execute()).length,
        0,
    );
});

Deno.test("a reaction to a local note its author may not see is refused", async () => {
    await using test = await open();
    const hidden = await createNote(test.a, test.alice, { visibility: "private" });

    await test.send(reaction("r1", `a.test:${hidden.id}`, "🎉"));

    assertEquals(await test.kept(), 0);
    assertEquals((await test.errors()).length, 1);
    assertStringIncludes((await test.errors())[0] ?? "", "may not see");
});

Deno.test("a local note lists other instances' reactions by their ids there", async () => {
    await using test = await open();
    await test.send(reaction("r1", `a.test:${test.local.id}`, "🎉"));

    assertEquals(
        await registry.types.get("Note")?.collections?.["pub.versia:reactions/Reactions"]?.(
            test.a,
            test.local.id,
            { offset: 0, limit: 40 },
            "c.test",
        ),
        { author: test.alice, total: 1, items: ["b.test:r1"] },
    );
});
