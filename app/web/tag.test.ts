import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Permissions, TimelinesAccess } from "../kernel/config_sections.ts";
import { createNote } from "../notes/testing.ts";
import { followTag } from "../tags/tag_follows.ts";
import { open, web } from "./testing.ts";

const post = (
    ctx: Parameters<typeof createNote>[0],
    accountId: string,
    text: string,
    tags: string[],
    note: Parameters<typeof createNote>[2] = {},
) => createNote(ctx, accountId, { content_html: `<p>${text}</p>`, ...note }, [], tags);

Deno.test("a hashtag's page shows its latest public posts to anyone, whatever they accept", async () => {
    await using test = await open();
    await post(test.ctx, "alice", "Local cats", ["Cats"]);
    await post(test.ctx, "bob", "Remote cats", ["cats"], {
        instance_id: "b.example",
        remote_id: "b1",
    });
    await post(test.ctx, "alice", "Unlisted cats", ["cats"], { visibility: "unlisted" });
    await post(test.ctx, "alice", "Dogs", ["dogs"]);

    for (const accept of ["*/*", "text/html", "application/json"]) {
        const response = await test.request("/tags/CATS", { headers: { accept } });

        assertEquals(response.status, 200, accept);
        assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
        assertStringIncludes(response.body, "<title>#Cats</title>");
        assertStringIncludes(response.body, "<h1>#Cats</h1>");
        assertStringIncludes(response.body, '<meta name="robots" content="noindex">');
        assertStringIncludes(response.body, '<meta property="og:title" content="#Cats">');
        assertStringIncludes(
            response.body,
            '<meta property="og:url" content="https://social.example/tags/cats">',
        );
        assertStringIncludes(response.body, '<meta property="og:type" content="website">');
        assertStringIncludes(response.body, "<p>Local cats</p>");
        assertStringIncludes(response.body, "<p>Remote cats</p>");
        assert(!response.body.includes("Unlisted cats"));
        assert(!response.body.includes("Dogs"));
    }
});

Deno.test("a hashtag's page shows posts only from where anyone may see hashtag feeds", async () => {
    const cases: [TimelinesAccess["topic_feeds"], boolean, boolean][] = [
        [{ local: "public", remote: "authenticated" }, true, false],
        [{ local: "authenticated", remote: "public" }, false, true],
        [{ local: "authenticated", remote: "disabled" }, false, false],
    ];
    for (const [topic_feeds, local, remote] of cases) {
        const timelinesAccess = TimelinesAccess.parse({ topic_feeds });
        await using test = await open({ timelinesAccess });
        await post(test.ctx, "alice", "Local cats", ["cats"]);
        await post(test.ctx, "bob", "Remote cats", ["cats"], {
            instance_id: "b.example",
            remote_id: "b1",
        });

        const response = await test.request("/tags/cats");

        assertEquals(response.status, 200, response.body);
        assertStringIncludes(response.body, "<h1>#cats</h1>");
        assertEquals(response.body.includes("Local cats"), local, JSON.stringify(topic_feeds));
        assertEquals(response.body.includes("Remote cats"), remote, JSON.stringify(topic_feeds));
    }
});

Deno.test("a hashtag's page shows at most 20 of its latest posts", async () => {
    await using test = await open();
    for (let index = 0; index < 21; index++) {
        await post(test.ctx, "alice", `Post ${index}`, ["cats"]);
    }

    const body = (await test.request("/tags/cats")).body;

    assertStringIncludes(body, "<p>Post 20</p>");
    assertStringIncludes(body, "<p>Post 1</p>");
    assert(!body.includes("<p>Post 0</p>"));
});

Deno.test("a hashtag only followed has a page, with no posts", async () => {
    await using test = await open();
    await followTag(test.ctx, "alice", "Quiet");

    const response = await test.request("/tags/quiet");

    assertEquals(response.status, 200);
    assertStringIncludes(response.body, "<h1>#Quiet</h1>");
    assert(!response.body.includes('class="posts"'));
});

Deno.test("an unknown hashtag, or a name that isn't one, gets the web app's page as a 404", async () => {
    await using test = await open({ web });

    for (const path of ["/tags/nothing", "/tags/not%20a%20tag", "/tags/%23cats"]) {
        const response = await test.request(path);

        assertEquals(response.status, 404, path);
        assertEquals(response.body, new TextDecoder().decode(web.page), path);
    }
});

Deno.test("a hashtag's page is left to the web app if anonymous visitors may not see statuses", async () => {
    const permissions = Permissions.parse({ anonymous: ["read:account"] });
    await using test = await open({ web, permissions });
    await post(test.ctx, "alice", "Local cats", ["cats"]);

    const response = await test.request("/tags/cats");

    assertEquals(response.status, 200);
    assertEquals(response.body, new TextDecoder().decode(web.page));
});
