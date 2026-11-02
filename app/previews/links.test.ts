import { assertEquals } from "@std/assert";
import { firstLink } from "./links.ts";

const first = (html: string) => firstLink(html, "social.example");

Deno.test("the first web link is used, as written", () => {
    assertEquals(
        first(
            `<p>See <a href="https://a.example/x?y=1">this</a> and <a href="https://b.example">that</a></p>`,
        ),
        "https://a.example/x?y=1",
    );
});

Deno.test("mentions, hashtags and profile cards are skipped", () => {
    assertEquals(
        first(
            `<p><span class="h-card"><a href="https://r.example/@bob" class="u-url mention">@<span>bob</span></a></span>` +
                `<a href="https://social.example/tags/cats" class="mention hashtag" rel="tag">#cats</a>` +
                `<a href="https://r.example/tags/dogs" rel="tag nofollow">#dogs</a>` +
                `<span class="h-card"><span><a href="https://r.example/@amy">Amy</a></span></span>` +
                `<a href="https://c.example/">link</a></p>`,
        ),
        "https://c.example/",
    );
});

Deno.test("links to this instance and to anything but web pages are skipped", () => {
    assertEquals(
        first(
            `<a href="https://social.example/x">here</a><a href="mailto:a@b.example">mail</a>` +
                `<a href="javascript:alert(1)">js</a><a href="/relative">rel</a><a>none</a>` +
                `<a href=" https://d.example/ ">d</a>`,
        ),
        "https://d.example/",
    );
});

Deno.test("a status without a link has none", () => {
    assertEquals(first(`<p>Hi<br>there</p>`), undefined);
    assertEquals(first(``), undefined);
});

Deno.test("elements that close themselves don't confuse profile cards", () => {
    assertEquals(
        first(`<span class="h-card">a<br><img src="x"></span><a href="https://e.example/">e</a>`),
        "https://e.example/",
    );
});
