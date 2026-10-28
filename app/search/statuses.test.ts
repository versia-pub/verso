import { assertEquals } from "@std/assert";
import type { Insertable } from "kysely";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { like } from "../interactions/likes.ts";
import { insertAttachments } from "../media/attachment_queries.ts";
import { saveRemoteMedia } from "../media/media_queries.ts";
import { share } from "../interactions/shares.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import type { NotesTable } from "../notes/tables.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { indexUnindexed } from "./notes.ts";
import { searchStatuses, type StatusSearch } from "./statuses.ts";

/** Alice, who searches, bob, who is `indexable`, carol, who isn't, and dan, on b.example. */
const open = async () => {
    const test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createRemoteAccount(test.ctx, "dan", "b.example");
    await updateProfile(test.ctx, "bob", { indexable: true });

    /**
     * Adds a status by `accountId` with `text`, mentioning `mentionIds` and using `tags`, and
     * indexes it.
     */
    const post = async (
        accountId: string,
        text: string,
        note: Partial<Insertable<NotesTable>> = {},
        mentionIds: string[] = [],
        tags: string[] = [],
    ) => {
        const row = await createNote(
            test.ctx,
            accountId,
            {
                content_html: `<p>${text}</p>`,
                ...note,
            },
            mentionIds,
            tags,
        );
        await indexUnindexed(test.ctx);
        return row.id;
    };

    /** The statuses alice finds with `query`, as `search` says. */
    const find = async (query: string, search: Partial<StatusSearch> = {}) => {
        const found = await searchStatuses(test.ctx, {
            query,
            viewerId: "alice",
            accountId: null,
            minId: null,
            maxId: null,
            limit: 40,
            offset: 0,
            ...search,
        });
        return found.map((note) => note.id);
    };

    return { ...test, post, find };
};

Deno.test("public statuses by indexable authors are found, and those the viewer took part in", async () => {
    await using test = await open();
    const indexable = await test.post("bob", "Quick fox");
    await test.post("bob", "Unlisted fox", { visibility: "unlisted" });
    const unindexable = await test.post("carol", "Quiet fox");
    const own = await test.post("alice", "My fox", { visibility: "private" });
    const mentioning = await test.post("carol", "Direct fox", { visibility: "direct" }, ["alice"]);
    const liked = await test.post("carol", "Liked fox");
    const boosted = await test.post("carol", "Boosted fox");
    await like(test.ctx, "alice", liked);
    await share(test.ctx, "alice", boosted);
    // What others took part in isn't enough.
    const others = await test.post("carol", "Others' fox", {}, ["bob"]);
    await like(test.ctx, "bob", others);
    await share(test.ctx, "bob", others);

    assertEquals(await test.find("fox"), [boosted, liked, mentioning, own, indexable]);
    assertEquals(await test.find("quiet"), []);

    // Until carol chooses to be found.
    await updateProfile(test.ctx, "carol", { indexable: true });
    assertEquals(await test.find("quiet"), [unindexable]);
});

Deno.test("boosts aren't found, only the statuses they boost", async () => {
    await using test = await open();
    const own = await test.post("alice", "My fox");
    const boosted = await test.post("bob", "Bob's fox");
    await share(test.ctx, "alice", boosted);
    await share(test.ctx, "alice", own);

    const cases: [string, string[]][] = [
        ["from:me", [own]],
        ["-fox from:me", []],
        // What alice boosted, as it is.
        ["in:library", [boosted, own]],
        ["in:library -nothing", [boosted, own]],
    ];
    for (const [query, found] of cases) assertEquals(await test.find(query), found, query);
});

Deno.test("a word of one letter is found whole, and longer ones as the start of words", async () => {
    await using test = await open();
    const plan = await test.post("bob", "Plan B");
    const both = await test.post("bob", "Bees and plans");

    assertEquals(await test.find("b"), [plan]);
    assertEquals(await test.find("be"), [both]);
    assertEquals(await test.find("pl"), [both, plan]);
    assertEquals(await test.find("p"), []);

    // In characters, as Verso counts them.
    const wide = await test.post("bob", "𠀀𠀁");
    assertEquals(await test.find("𠀀"), []);
    assertEquals(await test.find("𠀀𠀁"), [wide]);
});

Deno.test("a status the viewer may no longer see isn't found", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "carol");
    await drain(test.ctx, queues);
    const id = await test.post("carol", "Followers only", { visibility: "private" });
    await like(test.ctx, "alice", id);
    assertEquals(await test.find("followers"), [id]);

    await unfollow(test.ctx, "alice", "carol");
    assertEquals(await test.find("followers"), []);
});

Deno.test("statuses by accounts the viewer blocks or mutes aren't found", async () => {
    await using test = await open();
    const muted = await test.post("bob", "Hello");
    const blocked = await test.post("carol", "Hello", {}, ["alice"]);
    const remote = await test.post("dan", "Hello", { instance_id: "b.example" }, ["alice"]);
    assertEquals(await test.find("hello"), [remote, blocked, muted]);

    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 0 });
    await block(test.ctx, "alice", "carol");
    await blockDomainFor(test.ctx, "alice", "b.example");
    assertEquals(await test.find("hello"), []);
});

Deno.test("statuses are found newest first, by one author, between ids and a page at a time", async () => {
    await using test = await open();
    const ids = [];
    for (const id of ["bob", "alice", "bob", "bob", "alice"]) ids.push(await test.post(id, "Fox"));

    assertEquals(await test.find("fox", { accountId: "bob" }), [ids[3], ids[2], ids[0]]);
    assertEquals(await test.find("fox", { minId: ids[1], maxId: ids[4] }), [ids[3], ids[2]]);
    assertEquals(await test.find("fox", { limit: 2, offset: 1 }), [ids[3], ids[2]]);
    assertEquals(await test.find(" -- "), []);
});

Deno.test("statuses are found by phrases and hashtags, and without what a query excludes", async () => {
    await using test = await open();
    const fox = await test.post("bob", "Quick brown fox");
    const dog = await test.post("bob", "Brown, quick dog");
    const nix = await test.post("alice", "Nix and rust", {}, [], ["nix"]);
    const linux = await test.post("alice", "Linux");

    assertEquals(await test.find('"quick brown"'), [fox]);
    assertEquals(await test.find('"brown quick"'), [dog]);
    // A phrase's words are whole.
    assertEquals(await test.find('"quick bro"'), []);
    assertEquals(await test.find("brown -dog"), [fox]);
    assertEquals(await test.find('-"quick brown" -rust linux'), [linux]);
    // What a search excludes alone narrows nothing down, so finds nothing.
    assertEquals(await test.find('-"quick brown" -rust'), []);

    assertEquals(await test.find("#nix"), [nix]);
    assertEquals(await test.find("#rust"), []);
    assertEquals(await test.find("-#nix"), []);
    assertEquals(await test.find("-#nix linux"), [linux]);
    assertEquals(await test.find("-#nix rust"), []);
    assertEquals(await test.find("fox:quick"), [fox]);
});

Deno.test("statuses are found by Mastodon's prefixes: author, properties, language, time and where", async () => {
    await using test = await open();
    const at = (time: string) => ({ created_at: new Date(`${time}Z`) });
    const one = await test.post("bob", "Fox one", {
        ...at("2024-02-28T23:59:59.999"),
        language: "en",
        sensitive: true,
    });
    const two = await test.post("bob", "Fox two", {
        ...at("2024-02-29T00:00:00"),
        language: "pt",
        in_reply_to_id: one,
        in_reply_to_account_id: "bob",
    });
    const three = await test.post("alice", "Fox three", at("2024-02-29T23:59:59.999"));
    const media = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/fox.png",
        mediaType: "image/png",
    });
    await insertAttachments(test.ctx, three, [media]);
    // Found as alice is mentioned.
    const four = await test.post("dan", "Fox four", {
        ...at("2024-03-01T00:00:00"),
        instance_id: "b.example",
    }, ["alice"]);
    const all = [four, three, two, one];

    const cases: [string, string[]][] = [
        // Needing no words.
        ["from:me", [three]],
        ["fox -from:me", [four, two, one]],
        ["fox from:bob", [two, one]],
        ["fox -from:bob", [four, three]],
        ["fox from:@dan@b.example", [four]],
        ["fox from:dan", []],
        ["fox from:nobody", []],
        ["fox -from:nobody", all],
        ["fox has:media", [three]],
        ["fox has:image", [three]],
        ["fox -has:media", [four, two, one]],
        ["fox has:Media", []],
        ["fox has:poll", []],
        ["fox -has:poll", all],
        ["fox is:sensitive", [one]],
        ["fox is:reply", [two]],
        ["fox -is:reply", [four, three, one]],
        ["fox language:en", [one]],
        ["fox language:EN-gb", [one]],
        ["fox -language:en", [four, three, two]],
        ["fox before:2024-02-29", [one]],
        ["fox after:2024-02-28", [four, three, two]],
        ["fox during:2024-02-29", [three, two]],
        ["fox -during:2024-02-29", [four, one]],
        [`fox before:${Date.UTC(2024, 1, 29)}`, [one]],
        [`fox during:${Date.UTC(2024, 1, 29)}`, [two]],
        [`fox after:${Date.UTC(2024, 1, 29)}`, [four, three]],
        ["fox in:library", [four, three]],
        ["fox in:public", [two, one]],
        ["fox in:all", all],
        ["in:library", [four, three]],
        ["in:library has:media", [three]],
        ["fox -in:public from:bob", [two, one]],
        ["from:bob is:reply", [two]],
        // Narrowed down by nothing an index has.
        ["has:media", []],
        ["is:sensitive", []],
        ["language:en", []],
        ["-from:me", []],
        ["in:public", []],
        ["in:all", []],
    ];
    for (const [query, found] of cases) assertEquals(await test.find(query), found, query);

    // An author asked for narrows it down too.
    assertEquals(await test.find("is:reply", { accountId: "bob" }), [two]);
});
