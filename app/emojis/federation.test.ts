import { assertEquals, assertExists } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { publicAccount } from "../accounts/public.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { findRemoteNoteAt } from "../notes/note_queries.ts";
import { renderHistory, renderStatuses } from "../notes/render.ts";
import { registry } from "../registry.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";

/** The extension for emojis with these shortcodes, each with a picture at `<shortcode>.png`. */
const emojis = (...shortcodes: string[]) => ({
    "pub.versia:custom_emojis": {
        emojis: shortcodes.map((shortcode) => ({
            name: `:${shortcode}:`,
            content: { "image/png": { content: `https://b.test/${shortcode}.png`, remote: true } },
        })),
    },
});

/** bob, using the emojis of `extensions`. */
const user = (extensions: object) => ({
    type: "User",
    id: "bob",
    created_at: "2026-01-01T00:00:00Z",
    username: "bob",
    display_name: "Bob :blob:",
    fields: [],
    manually_approves_followers: false,
    indexable: true,
    extensions,
});

/** bob's public note `n1`, saying `text` with the emojis of `extensions`. */
const note = (text: string, extensions: object, created_at = "2026-01-01T00:00:00Z") => ({
    type: "Note",
    id: "n1",
    created_at,
    author: "bob",
    content: { "text/plain": { content: text, remote: false } },
    group: "public",
    is_sensitive: false,
    mentions: [],
    attachments: [],
    previews: [],
    extensions,
});

/** a.test, with alice, who follows bob, and b.test, which sends what it is told, with bob. */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", user(emojis("blob")));

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);
    await follow(a, alice, bob);

    /** Has b.test send `entity` to a.test, a second after the last, and a.test take it in. */
    const send = async (entity: object) => {
        network.clock.advance(1000);
        assertEquals(
            (await b.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };
    await send({
        type: "FollowAccept",
        author: "bob",
        follower: `a.test:${alice}`,
        created_at: "2026-01-01T00:00:00Z",
    });

    /** The shortcode and URL of each emoji `of` uses. */
    const shown = (of: { emojis: readonly { shortcode: string; url: string }[] }) =>
        of.emojis.map((emoji) => [emoji.shortcode, emoji.url]);

    /** bob's account, as the client API shows it. */
    const account = async () => {
        const row = await findAccount(a, bob);
        assertExists(row);
        return await publicAccount(a, row);
    };

    /** bob's note, as the client API shows it. */
    const status = async () => {
        const row = await findRemoteNoteAt(a, "b.test", "n1");
        assertExists(row);
        const [rendered] = await renderStatuses(a, [row], null);
        assertExists(rendered);
        return rendered;
    };

    return {
        network,
        a,
        b,
        bob,
        send,
        shown,
        account,
        status,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a remote user's emojis are shown with their account", async () => {
    await using test = await open();
    assertEquals((await test.account()).emojis, [{
        shortcode: "blob",
        url: "https://b.test/blob.png",
        static_url: "https://b.test/blob.png",
        visible_in_picker: false,
        category: null,
    }]);

    // Sent again with others, it uses only those.
    await test.send(user(emojis("cat")));
    assertEquals(test.shown(await test.account()), [["cat", "https://b.test/cat.png"]]);

    await test.send(user({}));
    assertEquals(test.shown(await test.account()), []);
});

Deno.test("a remote note's emojis are shown with it, and a newer version's replace them", async () => {
    await using test = await open();

    await test.send(note("Hi :blob: :cat:", emojis("blob", "cat")));
    assertEquals(test.shown(await test.status()), [
        ["blob", "https://b.test/blob.png"],
        ["cat", "https://b.test/cat.png"],
    ]);
    // Its author is shown with theirs.
    assertEquals(test.shown((await test.status()).account), [["blob", "https://b.test/blob.png"]]);

    await test.send(note("Hi :cat: :dog:", emojis("cat", "dog"), "2026-01-02T00:00:00Z"));
    const status = await test.status();
    assertEquals(test.shown(status), [
        ["cat", "https://b.test/cat.png"],
        ["dog", "https://b.test/dog.png"],
    ]);
    // Its history shows the emojis it uses now.
    const row = await findRemoteNoteAt(test.a, "b.test", "n1");
    assertExists(row);
    const history = await renderHistory(test.a, row);
    assertEquals(
        history.map(test.shown),
        [test.shown(status), test.shown(status)],
    );
});

Deno.test("an emoji's new picture is shown wherever its instance's emoji by that name is used", async () => {
    await using test = await open();
    await test.send(note("Hi :blob:", emojis("blob")));

    await test.send(user({
        "pub.versia:custom_emojis": {
            emojis: [{
                name: ":blob:",
                content: { "image/png": { content: "https://b.test/new.png", remote: true } },
            }],
        },
    }));

    assertEquals(test.shown(await test.account()), [["blob", "https://b.test/new.png"]]);
    assertEquals(test.shown(await test.status()), [["blob", "https://b.test/new.png"]]);
});

Deno.test("Verso says it supports custom emojis", () => {
    assertEquals(registry.extensions.includes("pub.versia:custom_emojis"), true);
});
