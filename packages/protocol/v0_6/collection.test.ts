import { assertEquals } from "@std/assert";
import { Collection, URICollection } from "./collection.ts";

const note = {
    id: "456df8ed-daf1-4062-abab-491071c7b8dd",
    type: "Note",
    created_at: "2024-04-09T01:38:51.743Z",
    attachments: [],
    author: "018ec082-0ae1-761c-b2c5-22275a611771",
    is_sensitive: false,
    mentions: [],
    previews: [],
    content: { "text/plain": { content: "Hello, world!", remote: false } },
};
const collection = {
    author: "018ec082-0ae1-761c-b2c5-22275a611771",
    total: 46,
    items: [note],
};

Deno.test("a Collection's items keep all their fields", () => {
    assertEquals(Collection.parse(collection).items, [note]);
});

Deno.test("the spec's example URI Collection is valid", () => {
    assertEquals(
        URICollection.safeParse({
            author: "018ec082-0ae1-761c-b2c5-22275a611771",
            total: 46,
            items: [
                "versia.social:f8b0d4b4-d354-4798-bbc5-c2ba8acabfe3",
                "social.bob.com:2B27E62snga763",
            ],
        }).success,
        true,
    );
});

Deno.test("the author is optional", () => {
    const { author: _, ...anonymous } = collection;
    assertEquals(Collection.safeParse(anonymous).success, true);
    assertEquals(
        URICollection.safeParse({ total: 0, items: [] }).success,
        true,
    );
});

Deno.test("invalid collections are rejected", () => {
    for (
        const bad of [
            { ...collection, total: -1 },
            { ...collection, total: 1.5 },
            { ...collection, items: undefined },
            { ...collection, items: [{ type: "Note" }] },
            { ...collection, author: "bad id!" },
        ]
    ) {
        assertEquals(
            Collection.safeParse(bad).success,
            false,
            JSON.stringify(bad),
        );
    }
    assertEquals(
        URICollection.safeParse({ total: 1, items: ["host:"] }).success,
        false,
    );
});
