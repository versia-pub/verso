import { assertEquals, assertFalse } from "@std/assert";
import { cursorsOf, linkHeader, offsetLinkHeader, offsetsOf, PageQuery } from "./paging.ts";

const Query = PageQuery({ default: 20, max: 40 });

Deno.test("a page holds the default, or as many as asked, up to the most there may be", () => {
    assertEquals(Query.parse({}), { limit: 20 });
    assertEquals(Query.parse({ limit: "5", max_id: "9" }), { limit: 5, max_id: "9" });
    assertEquals(Query.parse({ limit: 100 }).limit, 40);
    assertEquals(Query.parse({ limit: 0 }).limit, 1);
    assertFalse(Query.safeParse({ limit: -1 }).success);
    assertFalse(Query.safeParse({ limit: "many" }).success);
});

Deno.test("there are newer pages from the newest item, and older ones from a full page", () => {
    const page = Query.parse({ limit: 2 });
    const cursor = (item: { id: string }) => `cursor-${item.id}`;

    assertEquals(cursorsOf([{ id: "b" }, { id: "a" }], page, cursor), {
        newer: "cursor-b",
        older: "cursor-a",
    });
    assertEquals(cursorsOf([{ id: "b" }], page, cursor), { newer: "cursor-b", older: undefined });
    assertEquals(cursorsOf([], page, cursor), { newer: undefined, older: undefined });
});

Deno.test("links keep what was asked, but the cursors, and lead to the pages around", () => {
    const url = new URL(
        "https://social.example/api/v1/timelines/public?local=true&limit=5&max_id=9",
    );

    assertEquals(
        linkHeader(url, { newer: "8", older: "4" }),
        "<https://social.example/api/v1/timelines/public?local=true&limit=5&max_id=4>; " +
            'rel="next", ' +
            "<https://social.example/api/v1/timelines/public?local=true&limit=5&min_id=8>; " +
            'rel="prev"',
    );

    const since = new URL("https://social.example/api/v1/things?since_id=1&min_id=2");
    assertEquals(
        linkHeader(since, { newer: "3" }),
        '<https://social.example/api/v1/things?min_id=3>; rel="prev"',
    );
    assertEquals(linkHeader(url, {}), undefined);
});

Deno.test("a full page links to the next by offset, and later ones back, as Mastodon does", () => {
    assertEquals(offsetsOf(10, 0, 10), { next: 10, prev: undefined });
    assertEquals(offsetsOf(10, 10, 10), { next: 20, prev: undefined });
    assertEquals(offsetsOf(10, 25, 10), { next: 35, prev: 15 });
    assertEquals(offsetsOf(3, 25, 10), { next: undefined, prev: 15 });
    assertEquals(offsetsOf(0, 0, 10), { next: undefined, prev: undefined });
});

Deno.test("offset links keep what was asked, but the offset", () => {
    const url = new URL("https://social.example/api/v1/trends/tags?limit=10&offset=20");

    assertEquals(
        offsetLinkHeader(url, { next: 30, prev: 10 }),
        '<https://social.example/api/v1/trends/tags?limit=10&offset=30>; rel="next", ' +
            '<https://social.example/api/v1/trends/tags?limit=10&offset=10>; rel="prev"',
    );
    assertEquals(offsetLinkHeader(url, {}), undefined);
});
