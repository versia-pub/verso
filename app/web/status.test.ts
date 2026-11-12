import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Permissions } from "../kernel/config_sections.ts";
import type { MediaAttachment } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { renderStatuses } from "../notes/render.ts";
import { previewImages, StatusCard, statusDescription } from "./status.tsx";
import { open, web } from "./testing.ts";

/** Attaches a remote picture to the status `noteId`, described as `description`. */
const attachPicture = async (ctx: Context, noteId: string, description: string | null) => {
    const id = ctx.ids();
    await ctx.db.insertInto("media")
        .values({
            id,
            account_id: null,
            instance_id: "b.example",
            media_type: "image/png",
            url: `https://b.example/${id}.png`,
            width: 800,
            height: 600,
            description,
            created_at: ctx.clock.now(),
        })
        .execute();
    await ctx.db.insertInto("note_media").values({ note_id: noteId, media_id: id, position: 0 })
        .execute();
};

Deno.test("a status's page shows it to anyone, whatever they accept", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", {
        content_html: "<p>Hello, I like <b>cats</b> &amp; dogs.</p><p>Second paragraph.</p>",
        language: "en",
    });

    for (const accept of ["*/*", "text/html", "application/json"]) {
        const response = await test.request(`/@alice/${note.id}`, { headers: { accept } });

        assertEquals(response.status, 200, accept);
        assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
        assertStringIncludes(
            response.body,
            "<title>alice: &quot;Hello, I like cats &amp; dogs. Second paragraph.&quot;</title>",
        );
        assertStringIncludes(response.body, "<b>cats</b> &amp; dogs.");
        assertStringIncludes(response.body, '<meta property="og:type" content="article">');
        assertStringIncludes(
            response.body,
            '<meta property="og:title" content="alice (@alice@social.example)">',
        );
        assertStringIncludes(
            response.body,
            '<meta property="og:description" content="Hello, I like cats &amp; dogs. Second paragraph.">',
        );
        assertStringIncludes(
            response.body,
            `<meta property="og:url" content="https://social.example/@alice/${note.id}">`,
        );
        assertStringIncludes(
            response.body,
            `<meta property="og:published_time" content="${note.created_at.toISOString()}">`,
        );
        assertStringIncludes(response.body, '<meta property="og:locale" content="en">');
        assertStringIncludes(response.body, '<meta name="twitter:card" content="summary">');
    }
});

Deno.test("a status's page has no locale if its language isn't known", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    const response = await test.request(`/@alice/${note.id}`);

    assertEquals(response.status, 200);
    assert(!response.body.includes("og:locale"));
});

Deno.test("a status's page shows the statuses it replies to above it, and replies below", async () => {
    await using test = await open();
    const start = await createNote(test.ctx, "alice", { content_html: "<p>Start</p>" });
    const middle = await createNote(test.ctx, "bob", {
        instance_id: "b.example",
        remote_id: "b1",
        content_html: "<p>Middle</p>",
        in_reply_to_id: start.id,
        in_reply_to_account_id: "alice",
    });
    await createNote(test.ctx, "alice", {
        content_html: "<p>Reply</p>",
        in_reply_to_id: middle.id,
        in_reply_to_account_id: "bob",
    });
    await createNote(test.ctx, "alice", {
        content_html: "<p>Secret</p>",
        visibility: "private",
        in_reply_to_id: middle.id,
        in_reply_to_account_id: "bob",
    });

    const response = await test.request(`/@bob@b.example/${middle.id}`);

    assertEquals(response.status, 200);
    const startAt = response.body.indexOf("<p>Start</p>");
    const focusAt = response.body.indexOf('<article class="status focus">');
    const replyAt = response.body.indexOf("<p>Reply</p>");
    assert(0 < startAt && startAt < focusAt && focusAt < replyAt);
    assertEquals(response.body.split('<article class="status').length - 1, 3);
    assert(!response.body.includes("Secret"));
    assertEquals(test.transport.sent, []);
});

Deno.test("a status anyone may not see at its address has no page", async () => {
    await using test = await open({ web });
    const shown = await createNote(test.ctx, "alice");
    const followersOnly = await createNote(test.ctx, "alice", { visibility: "private" });
    const direct = await createNote(test.ctx, "alice", { visibility: "direct" });
    const boost = await createShare(test.ctx, "alice", shown.id);

    for (
        const path of [
            `/@bob@b.example/${shown.id}`,
            `/@nobody/${shown.id}`,
            `/@carol@b.example/${shown.id}`,
            `/@alice/${followersOnly.id}`,
            `/@alice/${direct.id}`,
            `/@alice/${boost.id}`,
            "/@alice/not-an-id",
        ]
    ) {
        const response = await test.request(path);

        assertEquals(response.status, 404, path);
        assertEquals(response.body, new TextDecoder().decode(web.page), path);
    }
    assertEquals(test.transport.sent, []);
});

Deno.test("a suspended account's statuses have no page", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts").set({ suspended_at: new Date() })
        .where("id", "=", "alice").execute();

    assertEquals((await test.request(`/@alice/${note.id}`)).status, 404);
});

Deno.test("a status anonymous visitors may not see is left to the web app", async () => {
    const permissions = Permissions.parse({ anonymous: ["read:account"] });
    await using test = await open({ web, permissions });
    const note = await createNote(test.ctx, "alice");

    const response = await test.request(`/@alice/${note.id}`);

    assertEquals(response.status, 200);
    assertEquals(response.body, new TextDecoder().decode(web.page));
});

Deno.test("a content warning hides the text from the title and link previews", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", {
        content_html: "<p>The ending</p>",
        spoiler_text: "Spoilers <3",
    });

    const response = await test.request(`/@alice/${note.id}`);

    assertStringIncludes(response.body, "<title>alice: &quot;Spoilers &lt;3&quot;</title>");
    assertStringIncludes(
        response.body,
        '<meta name="description" content="Content warning: Spoilers &lt;3">',
    );
    assertStringIncludes(
        response.body,
        '<details><summary>Spoilers &lt;3</summary><div class="content"><p>The ending</p></div>',
    );
});

Deno.test("a title shows the start of a long status", async () => {
    await using test = await open();
    const fits = await createNote(test.ctx, "alice", { content_html: `<p>${"a".repeat(50)}</p>` });
    const long = await createNote(test.ctx, "alice", {
        content_html: `<p>${"a".repeat(45)} ${"b".repeat(10)}</p>`,
    });

    assertStringIncludes(
        (await test.request(`/@alice/${fits.id}`)).body,
        `<title>alice: &quot;${"a".repeat(50)}&quot;</title>`,
    );
    assertStringIncludes(
        (await test.request(`/@alice/${long.id}`)).body,
        `<title>alice: &quot;${"a".repeat(45)} ${"b".repeat(3)}…&quot;</title>`,
    );
});

Deno.test("a link preview shows a status's pictures, unless it is sensitive", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await attachPicture(test.ctx, note.id, "A cat");
    const sensitive = await createNote(test.ctx, "alice", { sensitive: true });
    await attachPicture(test.ctx, sensitive.id, null);

    const shown = (await test.request(`/@alice/${note.id}`)).body;
    const hidden = (await test.request(`/@alice/${sensitive.id}`)).body;

    assertStringIncludes(shown, '<meta property="og:image" content="https://');
    assertStringIncludes(shown, '<meta property="og:image:width" content="800">');
    assertStringIncludes(shown, '<meta property="og:image:height" content="600">');
    assertStringIncludes(shown, '<meta property="og:image:alt" content="A cat">');
    assertStringIncludes(shown, '<meta name="twitter:card" content="summary_large_image">');
    assertStringIncludes(shown, 'alt="A cat"');
    assertStringIncludes(shown, "Attached: 1 image\n\nHi");
    assert(!hidden.includes('property="og:image"'));
    assertStringIncludes(hidden, '<meta name="twitter:card" content="summary">');
    assertStringIncludes(hidden, "<details><summary>Sensitive media</summary>");
});

Deno.test("a link preview says what media a status has, its warning, text and poll", async () => {
    await using test = await open();
    const [status] = await renderStatuses(test.ctx, [await createNote(test.ctx, "alice")], null);
    assert(status);
    const media = (type: "image" | "gifv" | "video" | "audio") => ({
        id: type,
        type,
        url: null,
        preview_url: null,
        remote_url: null,
        meta: null,
        description: null,
        blurhash: null,
    });
    const poll = {
        id: "1",
        expires_at: null,
        expired: false,
        multiple: false,
        votes_count: 0,
        voters_count: null,
        options: [{ title: "Yes", votes_count: 0 }, { title: "No", votes_count: 0 }],
        emojis: [],
    };

    assertEquals(statusDescription(status), "Hi");
    assertEquals(
        statusDescription({
            ...status,
            media_attachments: [media("image"), media("gifv"), media("video"), media("audio")],
        }),
        "Attached: 2 images · 1 video · 1 audio\n\nHi",
    );
    assertEquals(
        statusDescription({
            ...status,
            media_attachments: [media("video"), media("video"), media("audio"), media("audio")],
        }),
        "Attached: 2 videos · 2 audio\n\nHi",
    );
    assertEquals(
        statusDescription({ ...status, media_attachments: [media("audio")], spoiler_text: "CW" }),
        "Attached: 1 audio · Content warning: CW",
    );
    assertEquals(statusDescription({ ...status, poll }), "Hi\n\n[ ] Yes\n[ ] No");
    assertEquals(statusDescription({ ...status, poll, spoiler_text: "CW" }), "Content warning: CW");
});

Deno.test("only indexable local accounts' statuses may be indexed", async () => {
    await using test = await open();
    const noindex = '<meta name="robots" content="noindex, noarchive">';
    const local = await createNote(test.ctx, "alice");
    const remote = await createNote(test.ctx, "bob", { instance_id: "b.example", remote_id: "b1" });

    assertStringIncludes((await test.request(`/@alice/${local.id}`)).body, noindex);

    await test.ctx.db.updateTable("accounts").set({ indexable: true }).execute();

    assert(!(await test.request(`/@alice/${local.id}`)).body.includes(noindex));
    assertStringIncludes((await test.request(`/@bob@b.example/${remote.id}`)).body, noindex);
});

Deno.test("a HEAD request for a status's page gets its headers", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");

    const response = await test.request(`/@alice/${note.id}`, { method: "HEAD" });

    assertEquals(response.status, 200);
    assertEquals(response.body, "");
});

/** `alice`'s status "Hi", as anyone sees it, to try changes to. */
const aliceStatus = async (ctx: Context) => {
    const [status] = await renderStatuses(ctx, [await createNote(ctx, "alice")], null);
    assert(status);
    return status;
};

/** An attachment of `type`, with its picture at `preview` and its file at `url`. */
const attachment = (
    type: "image" | "video" | "audio",
    preview: string | null,
    url: string | null = null,
    meta: MediaAttachment["meta"] = null,
): MediaAttachment => ({
    id: type,
    type,
    url,
    preview_url: preview,
    remote_url: null,
    meta,
    description: null,
    blurhash: null,
});

Deno.test("a link preview shows an image's file, a video's preview, and no audio", async () => {
    await using test = await open();
    const status = await aliceStatus(test.ctx);
    const small = { width: 100, height: 50 };
    const original = { width: 200, height: 100 };

    const images = previewImages({
        ...status,
        media_attachments: [
            attachment("image", "https://a.example/small.png", "https://a.example/full.png", {
                original,
                small,
            }),
            attachment("video", "https://a.example/still.png", "https://a.example/v.mp4", {
                original,
                small,
            }),
            attachment("audio", "https://a.example/cover.png", "https://a.example/a.mp3"),
        ],
    });

    assertEquals(images, [
        { url: "https://a.example/full.png", size: original, alt: null },
        { url: "https://a.example/still.png", size: small, alt: null },
    ]);
});

Deno.test("a poll shows how many voted for each option, if that is known", async () => {
    await using test = await open();
    const status = await aliceStatus(test.ctx);
    const option = (title: string, votes_count: number | null) => ({ title, votes_count });

    const html = String(
        await StatusCard({
            ctx: test.ctx,
            status: {
                ...status,
                poll: {
                    id: "1",
                    expires_at: null,
                    expired: false,
                    multiple: false,
                    votes_count: 3,
                    voters_count: null,
                    options: [option("A", 0), option("B", 1), option("C", 2), option("D", null)],
                    emojis: [],
                },
            },
        }),
    );

    assertStringIncludes(
        html,
        '<ul class="poll"><li>A · 0 votes</li><li>B · 1 vote</li><li>C · 2 votes</li><li>D</li></ul>',
    );
});

Deno.test("sensitive media behind a content warning isn't hidden twice", async () => {
    await using test = await open();
    const status = await aliceStatus(test.ctx);
    const media = [attachment("image", "https://a.example/p.png")];

    const warned = String(
        await StatusCard({
            ctx: test.ctx,
            status: { ...status, sensitive: true, spoiler_text: "CW", media_attachments: media },
        }),
    );

    assertStringIncludes(warned, '<img src="https://a.example/p.png"');
    assert(!warned.includes("Sensitive media"));
});
