import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Instance, Permissions, TimelinesAccess } from "../kernel/config_sections.ts";
import { createNote } from "../notes/testing.ts";
import { open, web } from "./testing.ts";

const instance = Instance.parse({
    name: "Social <Example>",
    description: "A place for cats & dogs.",
    rules: [{ text: "Be kind", hint: "Even to dogs" }, { text: "No spam" }],
});

Deno.test("the front page shows the instance and its latest local posts, whatever is accepted", async () => {
    await using test = await open({ instance });
    await createNote(test.ctx, "alice", { content_html: "<p>Local post</p>" });
    await createNote(test.ctx, "alice", {
        content_html: "<p>Unlisted</p>",
        visibility: "unlisted",
    });
    await createNote(test.ctx, "bob", {
        content_html: "<p>Remote post</p>",
        instance_id: "b.example",
        remote_id: "b1",
    });

    for (const accept of ["*/*", "text/html", "application/json"]) {
        const response = await test.request("/", { headers: { accept } });

        assertEquals(response.status, 200, accept);
        assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
        const { body } = response;
        assertStringIncludes(body, "<title>Social &lt;Example&gt;</title>");
        assertStringIncludes(body, "<h1>Social &lt;Example&gt;</h1>");
        assertStringIncludes(body, '<p class="description">A place for cats &amp; dogs.</p>');
        assertStringIncludes(
            body,
            '<meta name="description" content="A place for cats &amp; dogs.">',
        );
        assertStringIncludes(body, '<meta property="og:title" content="Social &lt;Example&gt;">');
        assertStringIncludes(
            body,
            '<meta property="og:description" content="A place for cats &amp; dogs.">',
        );
        assertStringIncludes(body, '<meta property="og:type" content="website">');
        assertStringIncludes(body, '<meta property="og:url" content="https://social.example/">');
        assertStringIncludes(
            body,
            '<meta property="og:image" content="https://social.example/instance/thumbnail.png">',
        );
        assertStringIncludes(body, '<meta property="og:image:width" content="1500">');
        assertStringIncludes(body, '<meta property="og:image:height" content="500">');
        assertStringIncludes(body, '<meta name="twitter:card" content="summary_large_image">');
        assertStringIncludes(
            body,
            '<li>Be kind<p class="hint">Even to dogs</p></li><li>No spam</li>',
        );
        assert(!body.includes('name="robots"'));
        assertStringIncludes(body, "<p>Local post</p>");
        assert(!body.includes("Unlisted"));
        assert(!body.includes("Remote post"));
    }
});

Deno.test("without a name or description, the front page goes by the domain", async () => {
    await using test = await open();

    const { status, body } = await test.request("/");

    assertEquals(status, 200);
    assertStringIncludes(body, "<title>social.example</title>");
    assertStringIncludes(body, "<h1>social.example</h1>");
    assert(!body.includes('name="description"'));
    assert(!body.includes("og:description"));
    assert(!body.includes('class="description"'));
    assert(!body.includes('class="rules"'));
    assert(!body.includes('class="posts"'));
});

Deno.test("the front page shows at most 20 of the latest local posts", async () => {
    await using test = await open();
    for (let index = 0; index < 21; index++) {
        await createNote(test.ctx, "alice", { content_html: `<p>Post ${index}</p>` });
    }

    const body = (await test.request("/")).body;

    assertStringIncludes(body, "<p>Post 20</p>");
    assertStringIncludes(body, "<p>Post 1</p>");
    assert(!body.includes("<p>Post 0</p>"));
});

Deno.test("the front page shows no posts unless anyone may see statuses and the local feed", async () => {
    const cases: [Permissions | undefined, TimelinesAccess | undefined][] = [
        [undefined, TimelinesAccess.parse({ live_feeds: { local: "authenticated" } })],
        [undefined, TimelinesAccess.parse({ live_feeds: { local: "disabled" } })],
        [Permissions.parse({ anonymous: [] }), undefined],
    ];
    for (const [permissions, timelinesAccess] of cases) {
        await using test = await open({ web, instance, permissions, timelinesAccess });
        await createNote(test.ctx, "alice", { content_html: "<p>Local post</p>" });

        const { status, body } = await test.request("/");

        assertEquals(status, 200);
        assertStringIncludes(body, "<h1>Social &lt;Example&gt;</h1>");
        assert(!body.includes("Local post"));
    }
});

Deno.test("the front page shows local posts when only remote ones are hidden", async () => {
    const timelinesAccess = TimelinesAccess.parse({ live_feeds: { remote: "disabled" } });
    await using test = await open({ timelinesAccess });
    await createNote(test.ctx, "alice", { content_html: "<p>Local post</p>" });

    assertStringIncludes((await test.request("/")).body, "<p>Local post</p>");
});

Deno.test("the front page lists a single rule", async () => {
    await using test = await open({ instance: Instance.parse({ rules: [{ text: "Be kind" }] }) });

    assertStringIncludes((await test.request("/")).body, '<ol class="rules"><li>Be kind</li></ol>');
});
