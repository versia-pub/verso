import { assert, assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { drain } from "../jobs/worker.ts";
import { emit } from "../kernel/events.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { removeUnusedMedia } from "../media/cleanup.ts";
import type { NoteEdited, NotePosted, NoteReceived } from "../notes/events.ts";
import { findNote } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { cardHandler, cardsQueue, queueCards } from "./cards.ts";

const png = (width: number, height: number) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).fill(200),
        channels: 4,
    }));

const posted = (noteId: string): NotePosted => ({ type: "notes.posted", noteId });

const edit = (noteId: string): NoteEdited => ({ type: "notes.edited", noteId });

const received = (noteId: string): NoteReceived => ({
    type: "notes.received",
    noteId,
    edited: false,
    fetched: false,
});

const article = (head: string) => () =>
    new Response(`<html><head>${head}</head></html>`, {
        headers: { "content-type": "text/html" },
    });

const story = article(`<title>Story</title><meta property="og:image" content="/cover.png">
    <meta property="og:description" content="Summary"><meta property="og:site_name" content="News">`);

const cover = () => new Response(png(1280, 720), { headers: { "content-type": "image/png" } });

const queues = { [cardsQueue]: { handler: cardHandler, concurrency: 1 } };

const open = async (servers: Parameters<typeof fakeTransport>[0] = {}) => {
    const test = await createTestContext({
        transport: fakeTransport({
            "news.example": (request) =>
                new URL(request.url).pathname === "/cover.png" ? cover() : story(),
            ...servers,
        }),
        subscribers: [queueCards],
    });
    await createLocalAccount(test.ctx, "alice");

    const post = async (html: string, edited = false) => {
        const note = await createNote(test.ctx, "alice", { content_html: html });
        const event: NotePosted | NoteEdited = {
            type: edited ? "notes.edited" : "notes.posted",
            noteId: note.id,
        };
        await test.ctx.transaction((tx) => emit(tx, event));
        await drain(test.ctx, queues);

        return note.id;
    };

    const cardOf = async (noteId: string) => {
        const note = await findNote(test.ctx, noteId);
        if (!note) throw new Error("no note");

        return (await renderStatuses(test.ctx, [note], null))[0].card;
    };

    return Object.assign(test, { post, cardOf });
};

Deno.test("a status shows a card for its first link, with the page's image stored", async () => {
    await using test = await open();

    const id = await test.post(`<p>Read <a href="https://news.example/story">this</a></p>`);
    const card = await test.cardOf(id);

    assertEquals(card?.url, "https://news.example/story");
    assertEquals(card?.title, "Story");
    assertEquals(card?.description, "Summary");
    assertEquals(card?.provider_name, "News");
    assertEquals(card?.type, "link");
    assertEquals(card?.authors, []);
    assertEquals([card?.width, card?.height], [640, 360]);
    assert(card?.image?.startsWith("https://social.example/media/"));
    assert(card?.blurhash);

    const media = await test.ctx.db.selectFrom("media").selectAll().executeTakeFirstOrThrow();
    assertEquals([media.instance_id, media.account_id, media.media_type], [
        null,
        null,
        "image/png",
    ]);
    assert(media.sha256 !== null && await test.ctx.files.has(media.sha256));
});

Deno.test("a status without a link has no card, and the page isn't fetched", async () => {
    await using test = await open();

    const id = await test.post(`<p>No links</p>`);

    assertEquals(await test.cardOf(id), null);
    assertEquals(test.transport.sent.length, 0);
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("another status with the same link reuses the card without fetching again", async () => {
    await using test = await open();
    const link = `<a href="https://news.example/story">x</a>`;

    const first = await test.post(link);
    const sent = test.transport.sent.length;
    const second = await test.post(link);

    assertEquals(test.transport.sent.length, sent);
    assertEquals((await test.cardOf(second))?.title, "Story");
    assertEquals((await test.cardOf(first))?.title, "Story");
    assertEquals(
        await test.ctx.db.selectFrom("preview_cards").select("id").execute().then((r) => r.length),
        1,
    );
});

Deno.test("a card is made again when the page was last fetched over two weeks ago", async () => {
    let title = "Old";
    await using test = await open({
        "news.example": () => article(`<title>${title}</title>`)(),
    });
    const link = `<a href="https://news.example/story">x</a>`;

    await test.post(link);
    title = "New";
    test.clock.advance(13 * 24 * 60 * 60_000);
    const soon = await test.post(link);
    test.clock.advance(2 * 24 * 60 * 60_000);
    const later = await test.post(link);

    assertEquals((await test.cardOf(soon))?.title, "New");
    assertEquals((await test.cardOf(later))?.title, "New");
    assertEquals(await test.ctx.db.selectFrom("preview_cards").select("title").execute(), [{
        title: "New",
    }]);
});

Deno.test("editing the first link changes the card, and removing it removes the card", async () => {
    await using test = await open({
        "other.example": article(`<title>Other</title>`),
    });
    const id = await test.post(`<a href="https://news.example/story">x</a>`);

    await test.ctx.db.updateTable("notes")
        .set({ content_html: `<a href="https://other.example/">y</a>` }).where("id", "=", id)
        .execute();
    await test.ctx.transaction((tx) => emit(tx, edit(id)));
    await drain(test.ctx, queues);

    assertEquals((await test.cardOf(id))?.title, "Other");
    assertEquals((await test.cardOf(id))?.url, "https://other.example/");

    await test.ctx.db.updateTable("notes").set({ content_html: "<p>none</p>" })
        .where("id", "=", id).execute();
    await test.ctx.transaction((tx) => emit(tx, edit(id)));
    await drain(test.ctx, queues);

    assertEquals(await test.cardOf(id), null);
});

Deno.test("an edit that keeps the first link neither fetches nor queues anything", async () => {
    await using test = await open();
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    const sent = test.transport.sent.length;

    await test.ctx.transaction((tx) => emit(tx, edit(id)));

    assertEquals(await drain(test.ctx, queues), 0);
    assertEquals(test.transport.sent.length, sent);
});

Deno.test("no card is made when the page is missing, isn't HTML or has no title", async () => {
    await using test = await open({
        "gone.example": () =>
            new Response("no", { status: 404, headers: { "content-type": "text/html" } }),
        "pdf.example": () =>
            new Response("pdf", { headers: { "content-type": "application/pdf" } }),
        "blank.example": article(`<meta property="og:description" content="x">`),
    });

    for (const host of ["gone", "pdf", "blank", "unreachable"]) {
        const id = await test.post(`<a href="https://${host}.example/">x</a>`);

        assertEquals(await test.cardOf(id), null, host);
    }

    assertEquals(await test.ctx.db.selectFrom("preview_cards").select("id").execute(), []);
});

Deno.test("a card without a usable image has none", async () => {
    await using test = await open({
        "news.example": (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/cover.png") {
                return new Response("<p>not an image</p>", {
                    headers: { "content-type": "image/png" },
                });
            }

            return story();
        },
    });

    const card = await test.cardOf(await test.post(`<a href="https://news.example/story">x</a>`));

    assertEquals(card?.title, "Story");
    assertEquals([card?.image, card?.blurhash, card?.width, card?.height], [null, null, 0, 0]);
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
});

Deno.test("images that are too big, or not in a format Mastodon accepts, are not used", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(png(2, 2));
    const avif = new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode("ftypavif"), 0, 0, 0, 0]);

    for (const image of [big, avif]) {
        await using test = await open({
            "news.example": (request) =>
                new URL(request.url).pathname === "/cover.png"
                    ? new Response(image, { headers: { "content-type": "image/png" } })
                    : story(),
        });

        const card = await test.cardOf(
            await test.post(`<a href="https://news.example/story">x</a>`),
        );

        assertEquals(card?.image, null);
    }
});

Deno.test("a page naming its own address is stored under it", async () => {
    await using test = await open({
        "news.example": article(
            `<title>T</title><link rel="canonical" href="https://news.example/canon">`,
        ),
    });

    const card = await test.cardOf(
        await test.post(`<a href="https://news.example/story?utm=1">x</a>`),
    );

    assertEquals(card?.url, "https://news.example/story?utm=1");
    assertEquals(
        (await test.ctx.db.selectFrom("preview_cards").select("url").executeTakeFirstOrThrow()).url,
        "https://news.example/canon",
    );
});

Deno.test("a boost has no card of its own, and shows the card of the status it boosts", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    const boost = await createShare(test.ctx, "bob", id);
    await test.ctx.transaction((tx) => emit(tx, posted(boost.id)));

    assertEquals(await drain(test.ctx, queues), 0);

    const [rendered] = await renderStatuses(test.ctx, [boost], null);

    assertEquals(rendered.card, null);
    assertEquals(rendered.reblog?.card?.title, "Story");
});

Deno.test("a remote status waits up to a minute, then gets its card", async () => {
    await using test = await open();
    await createInstance(test.ctx, "r.example");
    const remote = await createRemoteAccount(test.ctx, "rem", "r.example");
    const note = await createNote(test.ctx, remote, {
        content_html: `<a href="https://news.example/story">x</a>`,
        instance_id: "r.example",
        remote_id: "1",
    });

    await test.ctx.transaction((tx) => emit(tx, received(note.id)));

    assertEquals(await drain(test.ctx, queues), 0);
    assertEquals(await test.cardOf(note.id), null);

    test.clock.advance(60_000);

    assertEquals(await drain(test.ctx, queues), 1);
    assertEquals((await test.cardOf(note.id))?.title, "Story");
});

Deno.test("the card's image is kept while the card uses it, and the link goes with the status", async () => {
    await using test = await open();
    const id = await test.post(`<a href="https://news.example/story">x</a>`);

    test.clock.advance(3 * 24 * 60 * 60_000);
    await removeUnusedMedia(test.ctx);

    assertEquals(
        await test.ctx.db.selectFrom("media").select("id").execute().then((r) => r.length),
        1,
    );

    await test.ctx.db.deleteFrom("notes").where("id", "=", id).execute();

    assertEquals(
        await test.ctx.db.selectFrom("note_preview_cards").select("note_id").execute(),
        [],
    );
    assertEquals(
        await test.ctx.db.selectFrom("preview_cards").select("id").execute().then((r) => r.length),
        1,
    );
});

Deno.test("a job for a status that is gone does nothing", async () => {
    await using test = await open();
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    await test.ctx.db.deleteFrom("note_preview_cards").execute();
    await test.ctx.db.deleteFrom("notes").where("id", "=", id).execute();

    await test.ctx.transaction((tx) => emit(tx, posted(id)));

    assertEquals(await drain(test.ctx, queues), 0);
});

Deno.test("a job for a status that already has the card of its link doesn't fetch the page", async () => {
    await using test = await open();
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    const sent = test.transport.sent.length;
    test.clock.advance(15 * 24 * 60 * 60_000);

    await enqueue(test.ctx, { queue: cardsQueue, payload: { noteId: id } });

    assertEquals(await drain(test.ctx, queues), 1);
    assertEquals(test.transport.sent.length, sent);
});

Deno.test("a job for a boost makes no card", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    const boost = await createShare(test.ctx, "bob", id);
    await test.ctx.db.updateTable("notes").set({
        content_html: `<a href="https://other.example/">x</a>`,
    }).where("id", "=", boost.id).execute();
    const sent = test.transport.sent.length;

    await enqueue(test.ctx, { queue: cardsQueue, payload: { noteId: boost.id } });

    assertEquals(await drain(test.ctx, queues), 1);
    assertEquals(test.transport.sent.length, sent);
    assertEquals(
        await test.ctx.db.selectFrom("note_preview_cards").select("note_id").execute(),
        [{ note_id: id }],
    );
});

Deno.test("a status deleted while its page is fetched gets no card", async () => {
    let remove = async () => {};
    await using test = await open({
        "news.example": async () => {
            await remove();
            return article("<title>Story</title>")();
        },
    });
    remove = async () => {
        await test.ctx.db.deleteFrom("note_preview_cards").execute();
        await test.ctx.db.deleteFrom("notes").execute();
    };

    await test.post(`<a href="https://news.example/story">x</a>`);

    assertEquals(await test.ctx.db.selectFrom("note_preview_cards").selectAll().execute(), []);
    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("an image that isn't processed yet isn't shown", async () => {
    await using test = await open();
    const id = await test.post(`<a href="https://news.example/story">x</a>`);
    await test.ctx.db.updateTable("media").set({ sha256: null }).execute();

    const card = await test.cardOf(id);

    assertEquals([card?.image, card?.blurhash, card?.width, card?.height], [null, null, 0, 0]);
});
