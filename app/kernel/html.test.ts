import { assertEquals } from "@std/assert";
import { sanitizeHtml, textOfHtml } from "./html.ts";

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
    assertEquals(sanitizeHtml('<iframe src="https://evil.example/"></iframe>'), "");
});

Deno.test("other attributes and classes are dropped", () => {
    assertEquals(
        sanitizeHtml('<p class="foo mention" style="color: red" onclick="alert(1)">a</p>'),
        '<p class="mention">a</p>',
    );
    assertEquals(sanitizeHtml('<span class="foo" id="x">a</span>'), "<span>a</span>");
});

Deno.test("links keep only full web addresses, and open apart", () => {
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
            "mailto:a@b.example",
            "not a url",
        ]
    ) {
        assertEquals(sanitizeHtml(`<a href="${href}">x</a>`), `<a ${link}>x</a>`, href);
    }
});

Deno.test("HTML as text keeps only the text, with blocks and line breaks as spaces", () => {
    assertEquals(
        textOfHtml("<p>Hi</p><p>#Verso &amp; <b>friends</b> &lt;3</p><script>x</script>"),
        " Hi  #Verso & friends <3 ",
    );
    assertEquals(
        textOfHtml(
            'Hi <a href="x">@<span>alice</span></a><br>and <LI>#<span>tag</span></li><picture>!',
        ),
        "Hi @alice and  #tag !",
    );
});
