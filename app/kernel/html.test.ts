import { assertEquals } from "@std/assert";
import { sanitizeHtml, sanitizerVersion, shownHtml, textOfHtml } from "./html.ts";

const link = 'rel="nofollow noopener noreferrer" target="_blank"';

Deno.test("formatting, lists and Mastodon's classes are kept", () => {
    for (
        const html of [
            '<p class="h-card mention">Hi <b>there</b>, <em>you</em><br /></p>',
            '<ol start="3" reversed><li value="5"><code>x</code></li></ol>',
            '<span class="invisible" translate="no">https://</span><span class="ellipsis">a</span>',
            "<blockquote><h2>Quote</h2><pre>code</pre></blockquote><hr />",
            "<table><tr><th>a</th><td>b</td></tr></table><details><summary>s</summary>t</details>",
            '<p>&lt;b&gt; &amp; "q"</p>',
        ]
    ) {
        assertEquals(sanitizeHtml(html), html);
    }
});

Deno.test("scripts, styles and comments are dropped, with what is in them", () => {
    assertEquals(
        sanitizeHtml("<p>a<script>alert(1)</script><style>p {}</style><!-- c -->b</p>"),
        "<p>ab</p>",
    );
    assertEquals(sanitizeHtml("<template><p>t</p></template><noscript>n</noscript>"), "");
});

Deno.test("other tags are dropped, keeping their text", () => {
    assertEquals(sanitizeHtml('<img src="https://evil.example/x.png" alt="x">'), "");
    assertEquals(sanitizeHtml('<input type="checkbox" checked> done'), " done");
    assertEquals(sanitizeHtml('<font color="red">red</font>'), "red");
    assertEquals(sanitizeHtml('<video src="https://evil.example/x.mp4">v</video>'), "v");
    assertEquals(sanitizeHtml('<audio src="https://evil.example/x.mp3"></audio>'), "");
});

Deno.test("iframes, objects, embeds, svg and math are dropped, with what is in them", () => {
    assertEquals(sanitizeHtml('<iframe src="https://evil.example/">inside</iframe>'), "");
    assertEquals(sanitizeHtml("<p>a<object>x</object><embed>b</p>"), "<p>ab</p>");
    assertEquals(sanitizeHtml("<svg><text>s</text></svg><math><mi>m</mi></math>"), "");
});

Deno.test("RichText's other elements and attributes are kept", () => {
    for (
        const html of [
            "<dl><dt>Term</dt><dd>Meaning</dd></dl>",
            "<p>E = mc<sup>2</sup>, H<sub>2</sub>O, <kbd>Ctrl</kbd>, <samp>ok</samp>, <var>x</var></p>",
            "<figure><p>f</p><figcaption>c</figcaption></figure>",
            '<p><abbr title="Versia">V</abbr> <cite>c</cite> <dfn>d</dfn> <q cite="https://b.example/">q</q></p>',
            '<p><time datetime="2026-01-02">d</time> <ins datetime="2026-01-02" cite="https://b.example/">i</ins></p>',
            '<p lang="fr" dir="rtl" title="t"><bdi>a</bdi><bdo dir="ltr">b</bdo>c<wbr /></p>',
            '<ol type="a" start="3" reversed><li value="5">x</li></ol>',
            '<table><tr><th colspan="2" rowspan="1" scope="col">a</th><td colspan="2">b</td></tr></table>',
            '<blockquote cite="https://b.example/">q</blockquote><details open><summary>s</summary>t</details>',
        ]
    ) {
        assertEquals(sanitizeHtml(html), html);
    }
});

Deno.test("language classes are kept on code and pre only", () => {
    assertEquals(
        sanitizeHtml('<pre class="language-rust"><code class="language-rust foo">x</code></pre>'),
        '<pre class="language-rust"><code class="language-rust">x</code></pre>',
    );
    assertEquals(sanitizeHtml('<p class="language-rust">x</p>'), "<p>x</p>");
    assertEquals(
        sanitizeHtml('<code class="language-rust mention h-x">x</code>'),
        '<code class="language-rust mention h-x">x</code>',
    );
});

Deno.test("data attributes other than a mention's are dropped", () => {
    assertEquals(
        sanitizeHtml('<span data-mfm-fn="tada" translate="no">a</span><p data-x="1">b</p>'),
        '<span translate="no">a</span><p>b</p>',
    );
});

Deno.test("other attributes and classes are dropped", () => {
    assertEquals(
        sanitizeHtml('<p class="foo mention" style="color: red" onclick="alert(1)">a</p>'),
        '<p class="mention">a</p>',
    );
    assertEquals(sanitizeHtml('<span class="foo" id="x">a</span>'), "<span>a</span>");
});

Deno.test("quotes and edits keep `cite` only if it is a full address with a RichText scheme", () => {
    assertEquals(
        sanitizeHtml('<q cite="https://b.example/">a</q><del cite="/r">b</del>'),
        '<q cite="https://b.example/">a</q><del>b</del>',
    );
    assertEquals(
        sanitizeHtml('<blockquote cite="http:b.example">a</blockquote><ins cite="x">b</ins>'),
        "<blockquote>a</blockquote><ins>b</ins>",
    );
});

Deno.test("links keep only full addresses with RichText's schemes, and open apart", () => {
    assertEquals(
        sanitizeHtml('<a href="https://b.example/?a=1&amp;b=2" class="u-url" rel="me">b</a>'),
        `<a ${link} class="u-url" href="https://b.example/?a=1&amp;b=2">b</a>`,
    );
    assertEquals(
        sanitizeHtml('<a href="http://b.example/" target="_self">b</a>'),
        `<a ${link} href="http://b.example/">b</a>`,
    );

    for (
        const href of [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            " javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "/oauth/authorize",
            "//evil.example/",
            "http:evil.example",
            "https:/evil.example",
            "not a url",
        ]
    ) {
        assertEquals(sanitizeHtml(`<a href="${href}">x</a>`), "<span>x</span>", href);
    }

    assertEquals(sanitizeHtml("<a>x</a>"), "<span>x</span>");
    assertEquals(
        sanitizeHtml('<a href="javascript:alert(1)" title="t" class="u-url">x</a>'),
        "<span>x</span>",
    );
});

Deno.test("links with a scheme RichText allows are kept", () => {
    for (
        const href of [
            "mailto:a@b.example",
            "gemini://b.example/page",
            "web+versia://b.example/user",
            "xmpp:a@b.example",
            "magnet:?xt=urn:btih:abc",
            "ipfs://abc",
        ]
    ) {
        assertEquals(sanitizeHtml(`<a href="${href}">x</a>`), `<a ${link} href="${href}">x</a>`);
    }

    assertEquals(sanitizeHtml('<a href="ftp://b.example/">x</a>'), "<span>x</span>");
});

Deno.test("a mention with a valid reference keeps it, and Mastodon's classes", () => {
    assertEquals(
        sanitizeHtml(
            '<a href="https://b.example/@joe" class="foo" data-mention="b.example:1j6q4w27wacfeazw5v">@joe</a>',
        ),
        `<a ${link} class="u-url mention" href="https://b.example/@joe" data-mention="b.example:1j6q4w27wacfeazw5v">@joe</a>`,
    );
});

Deno.test("a mention with an invalid reference is an ordinary link", () => {
    for (const mention of ["joe", "b.example:", "https://b.example/@joe", ""]) {
        assertEquals(
            sanitizeHtml(`<a href="https://b.example/@joe" data-mention="${mention}">@joe</a>`),
            `<a ${link} href="https://b.example/@joe">@joe</a>`,
            mention,
        );
    }

    assertEquals(
        sanitizeHtml('<a href="/@joe" data-mention="b.example:1j6q4w27wacfeazw5v">@joe</a>'),
        "<span>@joe</span>",
    );
});

Deno.test("the sanitiser is at version 2", () => {
    assertEquals(sanitizerVersion, 2);
});

Deno.test("HTML as text keeps only the text, with blocks and line breaks as spaces", () => {
    assertEquals(
        textOfHtml("<p>Hi</p><p>#Verso &amp; <b>friends</b> &lt;3</p><script>x</script>"),
        " Hi  #Verso & friends <3 ",
    );
    assertEquals(
        textOfHtml(
            "<dl><dt>a</dt><dd>b</dd><dd>c</dd></dl><figure>d<figcaption>e</figcaption></figure>",
        ).trim().split(/\s+/),
        ["a", "b", "c", "d", "e"],
    );
    assertEquals(
        textOfHtml(
            'Hi <a href="x">@<span>alice</span></a><br>and <LI>#<span>tag</span></li><picture>!',
        ),
        "Hi @alice and  #tag !",
    );
});

Deno.test("stored HTML is shown as it is if this sanitiser went through it, and sanitised if not", () => {
    const html = '<p onclick="x">Hi</p>';

    assertEquals(shownHtml(html, sanitizerVersion), html);
    assertEquals(shownHtml(html, 0), "<p>Hi</p>");
    assertEquals(shownHtml(html, sanitizerVersion + 1), "<p>Hi</p>");
});
