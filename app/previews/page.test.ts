import { assertEquals } from "@std/assert";
import { readPage } from "./page.ts";

const url = new URL("https://news.example/story");
const read = (html: string) => readPage(html, url);

Deno.test("a page's Open Graph tags give its card", () => {
    const page = read(`<html lang="en-GB"><head>
        <title>Tab title</title>
        <meta property="og:title" content="  A &amp; B
            story ">
        <meta property="og:description" content="What happened">
        <meta property="og:image" content="/cover.png">
        <meta property="og:image:alt" content="A cover">
        <meta property="og:site_name" content="News">
        <meta property="og:site" content="news.example">
        <meta property="og:author" content="Ann">
        <meta property="og:type" content="article">
        <meta property="article:published_time" content="2026-01-02T03:04:05Z">
        <link rel="canonical" href="https://news.example/stories/1">
    </head><body></body></html>`);

    assertEquals(page, {
        title: "A & B story",
        description: "What happened",
        imageUrl: "https://news.example/cover.png",
        imageDescription: "A cover",
        providerName: "News",
        providerUrl: "https://news.example/",
        authorName: "Ann",
        authorUrl: "",
        language: "en",
        publishedAt: new Date("2026-01-02T03:04:05Z"),
        canonicalUrl: "https://news.example/stories/1",
        linkType: "article",
    });
});

Deno.test("without Open Graph, the title and the description tag are used", () => {
    const page = read(`<title>Just a title</title><meta name="description" content="Plain">`);

    assertEquals(page?.title, "Just a title");
    assertEquals(page?.description, "Plain");
    assertEquals(page?.imageUrl, null);
    assertEquals(page?.imageDescription, "");
    assertEquals(page?.linkType, "unknown");
    assertEquals(page?.language, null);
});

Deno.test("JSON-LD is preferred to the other tags", () => {
    const page = read(`<head><title>Tab</title>
        <meta property="og:title" content="OG">
        <script type="application/ld+json">{"@graph": [
            {"@type": "Organization", "name": "Ignored"},
            {"@type": ["NewsArticle"], "headline": "Headline", "description": "Summary",
             "publisher": {"name": "The Paper"}, "inLanguage": "fr_CA",
             "datePublished": "2026-05-06T07:08:09Z",
             "author": [{"name": "Bea", "url": "/people/bea"}]}
        ]}</script></head>`);

    assertEquals(page?.title, "Headline");
    assertEquals(page?.description, "Summary");
    assertEquals(page?.providerName, "The Paper");
    assertEquals(page?.authorName, "Bea");
    assertEquals(page?.authorUrl, "https://news.example/people/bea");
    assertEquals(page?.language, "fr");
    assertEquals(page?.publishedAt, new Date("2026-05-06T07:08:09Z"));
    assertEquals(page?.linkType, "article");
});

Deno.test("JSON-LD that can't be read is skipped", () => {
    const page = read(`<title>T</title>
        <script type="application/ld+json">{not json</script>
        <script type="application/ld+json">{"@type": "WebPage", "headline": "H"}</script>`);

    assertEquals(page?.title, "H");
});

Deno.test("a page with no title has no card", () => {
    assertEquals(read(`<meta property="og:description" content="x">`), undefined);
    assertEquals(read(`<title>   </title>`), undefined);
});

Deno.test("only the first of each tag counts, and the title tag is read once", () => {
    const page = read(`<title>First</title><title>Second</title>
        <meta property="og:description" content="One"><meta property="og:description" content="Two">`);

    assertEquals(page?.title, "First");
    assertEquals(page?.description, "One");
});

Deno.test("images that aren't web addresses are ignored", () => {
    assertEquals(
        read(`<title>T</title><meta property="og:image" content="data:image/png;base64,AA">`)
            ?.imageUrl,
        null,
    );
    assertEquals(
        read(`<title>T</title><meta property="og:image" content="ftp://x.example/a.png">`)
            ?.imageUrl,
        null,
    );
});

Deno.test("a canonical address on another site is not used", () => {
    assertEquals(
        read(`<title>T</title><link rel="canonical" href="https://other.example/story">`)
            ?.canonicalUrl,
        null,
    );
    assertEquals(
        read(`<title>T</title><meta property="og:url" content="https://news.example/s">`)
            ?.canonicalUrl,
        "https://news.example/s",
    );
});

Deno.test("a site without a scheme is given one, and a bad language is dropped", () => {
    const page = read(`<title>T</title><meta property="og:site" content="http://news.example/a">
        <meta property="og:locale" content="klingon-x-?">`);

    assertEquals(page?.providerUrl, "http://news.example/a");
    assertEquals(page?.language, null);
});

Deno.test("long fields are cut", () => {
    const page = read(`<title>${"a".repeat(400)}</title>`);

    assertEquals(page?.title.length, 300);
});

Deno.test("an invalid publication date is ignored", () => {
    assertEquals(
        read(`<title>T</title><meta property="article:published_time" content="soon">`)
            ?.publishedAt,
        null,
    );
});

Deno.test("an image description without an image is dropped", () => {
    const page = read(`<title>T</title><meta property="og:image:alt" content="A cat">`);

    assertEquals(page?.imageDescription, "");
});
