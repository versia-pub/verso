import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalEmoji } from "../emojis/testing.ts";
import { Permissions } from "../kernel/config_sections.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { open, web } from "./testing.ts";

Deno.test("a local account's page shows its profile to anyone, whatever they accept", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({
            display_name: "Alice <3",
            note_html: "<p>Hello, I like <b>cats</b> &amp; dogs.</p><p>Second paragraph.</p>",
            statuses_count: 3,
            followers_count: 5,
            following_count: 4,
        })
        .where("id", "=", "alice")
        .execute();

    for (const accept of ["*/*", "text/html", "application/json"]) {
        const response = await test.request("/@alice", { headers: { accept } });

        assertEquals(response.status, 200, accept);
        assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
        assertEquals(response.headers.get("cache-control"), "no-cache");
        assertStringIncludes(response.body, "<title>Alice &lt;3 (@alice@social.example)</title>");
        assertStringIncludes(response.body, "<h1>Alice &lt;3</h1>");
        assertStringIncludes(response.body, "<b>cats</b> &amp; dogs.");
        assertStringIncludes(response.body, "3 posts · 4 following · 5 followers");
        assertStringIncludes(
            response.body,
            '<meta property="og:title" content="Alice &lt;3 (@alice@social.example)">',
        );
        assertStringIncludes(
            response.body,
            '<meta property="og:description" content="Hello, I like cats &amp; dogs. Second paragraph.">',
        );
        assertStringIncludes(
            response.body,
            '<meta property="og:url" content="https://social.example/@alice">',
        );
        assertStringIncludes(
            response.body,
            '<meta property="og:image" content="https://social.example/accounts/alice/avatar.png">',
        );
        assertStringIncludes(
            response.body,
            '<meta property="profile:username" content="alice@social.example">',
        );
    }
});

Deno.test("a page is the web app's, with the view's head tags and content put into it", async () => {
    await using test = await open({ web });

    const response = await test.request("/@alice");

    assertEquals(response.status, 200);
    assert(response.body.startsWith("<!doctype html>\n<html><head><link rel=modulepreload>"));
    assert(response.body.includes("<title>alice (@alice@social.example)</title>"));
    assert(response.body.indexOf("<title>") < response.body.indexOf("</head>"));
    assert(response.body.includes('<body class="app"><main class="verso-view">'));
    assert(response.body.endsWith("</main><div><script>start()</script></div></body></html>\n"));
    assertEquals(
        response.headers.get("content-security-policy"),
        "default-src 'none'; script-src 'self' 'sha256-start'; frame-ancestors 'none'",
    );
});

Deno.test("without the web app, a page is a bare one, which runs no scripts", async () => {
    await using test = await open();

    const response = await test.request("/@alice");

    assert(response.body.startsWith("<!doctype html>"));
    assert(!response.body.includes("<script"));
    assertEquals(
        response.headers.get("content-security-policy"),
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; " +
            "frame-ancestors 'none'",
    );
});

Deno.test("only indexable local accounts' pages may be indexed", async () => {
    await using test = await open();
    const noindex = '<meta name="robots" content="noindex, noarchive">';

    assertStringIncludes((await test.request("/@alice")).body, noindex);

    await test.ctx.db.updateTable("accounts").set({ indexable: true }).execute();

    assert(!(await test.request("/@alice")).body.includes(noindex));
    assertStringIncludes((await test.request("/@bob@b.example")).body, noindex);
});

Deno.test("a remote account Verso knows has a page, and one it doesn't is never fetched", async () => {
    await using test = await open({ web });

    const known = await test.request("/@bob@b.example");
    const unknown = await test.request("/@carol@b.example");
    const elsewhere = await test.request("/@dave@c.example");

    assertEquals(known.status, 200);
    assertStringIncludes(known.body, "<title>bob (@bob@b.example)</title>");
    assertStringIncludes(
        known.body,
        '<meta property="og:url" content="https://social.example/@bob@b.example">',
    );
    assertEquals(unknown.status, 404);
    assertEquals(elsewhere.status, 404);
    assertEquals(unknown.body, new TextDecoder().decode(web.page));
    assertEquals(test.transport.sent, []);
});

Deno.test("an address that is no account's gets the web app's page, as a 404", async () => {
    await using test = await open({ web });

    for (const path of ["/@nobody", "/@@alice", "/@alice@b.example@c.example"]) {
        const response = await test.request(path);

        assertEquals(response.status, 404, path);
        assertEquals(response.body, new TextDecoder().decode(web.page), path);
    }
});

Deno.test("without the web app, an address that is no account's is a 404", async () => {
    await using test = await open();

    assertEquals((await test.request("/@nobody")).status, 404);
});

Deno.test("a profile anonymous visitors may not see is left to the web app", async () => {
    const permissions = Permissions.parse({ anonymous: [] });
    await using test = await open({ web, permissions });

    const response = await test.request("/@alice");

    assertEquals(response.status, 200);
    assertEquals(response.body, new TextDecoder().decode(web.page));
});

Deno.test("a suspended account's page says so, and shows nothing of it", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ display_name: "Alice", note_html: "<p>Secret</p>", suspended_at: new Date() })
        .where("id", "=", "alice")
        .execute();

    const response = await test.request("/@alice");

    assertStringIncludes(response.body, "This account is suspended.");
    assert(!response.body.includes("Secret"));
    assert(!response.body.includes("Alice"));
});

Deno.test("a moved account's page links to where it moved", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ moved_to_account_id: "bob" })
        .where("id", "=", "alice")
        .execute();

    const response = await test.request("/@alice");

    assertStringIncludes(
        response.body,
        'Moved to <a href="https://social.example/@bob@b.example">@bob@b.example</a>',
    );
});

Deno.test("a HEAD request for an account's page gets its headers", async () => {
    await using test = await open();

    const response = await test.request("/@alice", { method: "HEAD" });

    assertEquals(response.status, 200);
    assertEquals(response.body, "");
    assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
});

Deno.test("a link preview shows the start of a long bio", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ note_html: `<p>${"a".repeat(150)} ${"b".repeat(20)}</p>` })
        .where("id", "=", "alice")
        .execute();

    const response = await test.request("/@alice");

    assertStringIncludes(
        response.body,
        `<meta name="description" content="${"a".repeat(150)} ${"b".repeat(8)}…">`,
    );
});

Deno.test("a bio that fits is the whole description, and no bio is none", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ note_html: `<p>${"a".repeat(160)}</p>` })
        .where("id", "=", "alice")
        .execute();

    assertStringIncludes(
        (await test.request("/@alice")).body,
        `<meta name="description" content="${"a".repeat(160)}">`,
    );

    const bare = (await test.request("/@bob@b.example")).body;
    assert(!bare.includes('name="description"'));
    assert(!bare.includes('property="og:description"'));
});

Deno.test("a profile shows its fields and emojis in its bio and fields", async () => {
    await using test = await open();
    const emojiId = await createLocalEmoji(test.ctx, "blob");
    await test.ctx.db.updateTable("accounts")
        .set({
            note_html: "<p>Hi :blob:</p>",
            fields: [{
                name: "Site",
                value: "is :blob:",
                format: "text/plain",
                name_html: "Site",
                value_html: "is :blob:",
            }],
        })
        .where("id", "=", "alice")
        .execute();
    await test.ctx.db.insertInto("account_emojis")
        .values({ account_id: "alice", emoji_id: emojiId })
        .execute();

    const body = (await test.request("/@alice")).body;

    assertStringIncludes(body, '<div class="note"><p>Hi <img class="emoji"');
    assertStringIncludes(body, '<dl class="fields"><dt>Site</dt><dd>is <img class="emoji"');
});

Deno.test("a profile shows pinned posts, then the latest, with boosts but not replies", async () => {
    await using test = await open();
    const first = await createNote(test.ctx, "alice", { content_html: "<p>First</p>" });
    const bobs = await createNote(test.ctx, "bob", {
        instance_id: "b.example",
        remote_id: "b1",
        content_html: "<p>By Bob</p>",
    });
    const hidden = await createNote(test.ctx, "bob", {
        instance_id: "b.example",
        remote_id: "b2",
        content_html: "<p>Hidden</p>",
        visibility: "private",
    });
    await createShare(test.ctx, "alice", bobs.id);
    await createShare(test.ctx, "alice", hidden.id);
    await createNote(test.ctx, "alice", {
        content_html: "<p>A reply</p>",
        in_reply_to_id: bobs.id,
        in_reply_to_account_id: "bob",
    });
    await createNote(test.ctx, "alice", { content_html: "<p>Secret</p>", visibility: "private" });
    await createNote(test.ctx, "alice", { content_html: "<p>Latest</p>" });
    await test.ctx.db.insertInto("note_pins")
        .values({
            id: test.ctx.ids(),
            account_id: "alice",
            note_id: first.id,
            created_at: test.clock.now(),
        })
        .execute();

    const body = (await test.request("/@alice")).body;

    const pinned = body.indexOf("<p>First</p>");
    const latest = body.indexOf("<p>Latest</p>");
    const boosted = body.indexOf("boosted</p>");
    assert(0 < pinned && pinned < latest && latest < boosted);
    assert(boosted < body.indexOf("<p>By Bob</p>"));
    assert(latest < body.lastIndexOf("<p>First</p>"));
    assert(!body.includes("A reply"));
    assert(!body.includes("Secret"));
    assert(!body.includes("Hidden"));
});

Deno.test("a profile shows at most 20 of the latest posts", async () => {
    await using test = await open();
    for (let index = 0; index < 21; index++) {
        await createNote(test.ctx, "alice", { content_html: `<p>Post ${index}</p>` });
    }

    const body = (await test.request("/@alice")).body;

    assertStringIncludes(body, "<p>Post 20</p>");
    assertStringIncludes(body, "<p>Post 1</p>");
    assert(!body.includes("<p>Post 0</p>"));
});

Deno.test("a suspended account's page shows none of its posts", async () => {
    await using test = await open();
    await createNote(test.ctx, "alice", { content_html: "<p>Posted</p>" });
    await test.ctx.db.updateTable("accounts").set({ suspended_at: new Date() })
        .where("id", "=", "alice").execute();

    assert(!(await test.request("/@alice")).body.includes("Posted"));
});

Deno.test("a profile shows a boost only if anyone may see the status it boosts", async () => {
    await using test = await open();
    const bobs = await createNote(test.ctx, "bob", { instance_id: "b.example", remote_id: "b1" });
    await createShare(test.ctx, "alice", bobs.id);
    await test.ctx.db.updateTable("notes").set({ visibility: "private" })
        .where("id", "=", bobs.id).execute();

    const body = (await test.request("/@alice")).body;

    assert(!body.includes('class="posts"'));
    assert(!body.includes('<article class="status'));
});

Deno.test("a profile's latest posts are those anyone may see", async () => {
    await using test = await open();
    await createNote(test.ctx, "alice", { content_html: "<p>Public</p>" });
    for (let index = 0; index < 20; index++) {
        await createNote(test.ctx, "alice", { visibility: "private" });
    }

    assertStringIncludes((await test.request("/@alice")).body, "<p>Public</p>");
});
