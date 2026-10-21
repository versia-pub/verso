import { assertEquals } from "@std/assert";
import { countText, type Links, renderText, scanText } from "./markup.ts";

const links: Links = {
    mention: (mention) =>
        mention.username === "nobody"
            ? undefined
            : `https://a.example/@${mention.username}${mention.domain ? `@${mention.domain}` : ""}`,
    hashtag: (tag) => `https://a.example/tags/${tag}`,
};

const mention = (username: string, href: string) =>
    `<span class="h-card" translate="no"><a href="${href}" class="u-url mention">` +
    `@<span>${username}</span></a></span>`;

const hashtag = (tag: string) =>
    `<a href="https://a.example/tags/${tag}" class="mention hashtag" rel="tag">` +
    `#<span>${tag}</span></a>`;

const link = (href: string, text = href) =>
    `<a href="${href}" rel="nofollow noopener noreferrer" target="_blank">${text}</a>`;

Deno.test("mentions, hashtags and custom emoji are found, each once, as first written", () => {
    const text =
        "Hi @alice and @bob@B.Example, @Alice! #Verso #verso #a1 :blob: :blob: @carol@b.example";

    assertEquals(scanText(text, "text/plain"), {
        mentions: [
            { username: "alice", domain: null },
            { username: "bob", domain: "b.example" },
            { username: "carol", domain: "b.example" },
        ],
        hashtags: ["Verso", "a1"],
        shortcodes: ["blob"],
    });
});

Deno.test("what only looks like a mention, hashtag or emoji isn't one", () => {
    const text =
        "bob@b.example a#b x)#y #123 url/#x url/@x https://a.example/#frag :a: ::bb:: x:cc: :dd:e (#ok)";

    assertEquals(scanText(text, "text/plain"), {
        mentions: [],
        hashtags: ["ok"],
        shortcodes: [],
    });
});

Deno.test("plain text is escaped, in paragraphs and line breaks, with links", () => {
    assertEquals(
        renderText(
            "Hi @alice, @nobody #Verso :blob:\n<b>x</b> &amp; \\*y\\*\n\n\nsee https://a.example/?a=1&b",
            "text/plain",
            links,
        ),
        `<p>Hi ${mention("alice", "https://a.example/@alice")}, @nobody ${hashtag("Verso")} ` +
            ":blob:<br>&lt;b&gt;x&lt;/b&gt; &amp;amp; \\*y\\*</p>" +
            `<p>see ${link("https://a.example/?a=1&amp;b")}</p>`,
    );
});

Deno.test("Markdown is HTML, but not raw HTML, pictures or links that aren't to the web", () => {
    assertEquals(
        renderText(
            "**Hi** @bob@b.example\n\n- one\n- two\n\n<script>x</script> ![p](https://b.example/p.png) [js](javascript:alert(1))",
            "text/markdown",
            links,
        ),
        `<p><strong>Hi</strong> ${mention("bob", "https://a.example/@bob@b.example")}</p>` +
            "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n" +
            `<p>&lt;script&gt;x&lt;/script&gt; !${link("https://b.example/p.png", "p")} ` +
            "[js](javascript:alert(1))</p>",
    );
});

Deno.test("nothing in code or links is a mention or hashtag", () => {
    const text =
        "`@alice #code` [#tag @bob](https://a.example) https://a.example/@carol\n\n    @dave";

    assertEquals(scanText(text, "text/markdown"), { mentions: [], hashtags: [], shortcodes: [] });
    assertEquals(
        renderText("`@alice` [#tag](https://a.example)", "text/markdown", links),
        `<p><code>@alice</code> ${link("https://a.example", "#tag")}</p>`,
    );
});

Deno.test("without links, mentions and hashtags stay text", () => {
    assertEquals(renderText("@alice #tag", "text/plain"), "<p>@alice #tag</p>");
    assertEquals(renderText("", "text/markdown"), "");
});

Deno.test("only web addresses with a scheme are links", () => {
    assertEquals(
        renderText("bob@example.com or example.com", "text/plain"),
        "<p>bob@example.com or example.com</p>",
    );
    assertEquals(
        renderText("[here](/a) [mail](mailto:bob@b.example)", "text/markdown"),
        "<p>[here](/a) [mail](mailto:bob@b.example)</p>",
    );
});

Deno.test("HTML ends where its last block does", () => {
    assertEquals(renderText("- one", "text/markdown"), "<ul>\n<li>one</li>\n</ul>");
});

Deno.test("text is counted as readers see it, with links and remote mentions shortened", () => {
    assertEquals(countText("Hi there"), 8);
    assertEquals(countText("👍🏽 and 👨‍👩‍👧"), 7);
    assertEquals(countText(`See https://example.com/${"a".repeat(100)}!`), 4 + 23 + 1);
    assertEquals(countText("See mailto:a@b.example and example.com"), 38);
    assertEquals(countText("Hi @bob@b.example and @carol"), 3 + 4 + 5 + 6);
});
