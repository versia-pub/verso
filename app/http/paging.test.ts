import { assertEquals, assertFalse } from "@std/assert";
import { cursorsOf, linkHeader, PageQuery } from "./paging.ts";

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
