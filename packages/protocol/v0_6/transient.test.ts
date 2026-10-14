import { assertEquals } from "@std/assert";
import { Delete } from "./delete.ts";
import { Follow, FollowAccept, FollowReject, Unfollow } from "./follow.ts";

const base = {
    author: "6e0204a2-746c-4972-8602-c4f37fc63bbe",
    created_at: "2021-01-01T00:00:00.000Z",
};
const other = "example.com:02e1e3b2-cb1f-4e4a-b82e-98866bee5de7";

// The spec's examples, one per entity.
const examples = [
    [Follow, { ...base, type: "Follow", followee: other }],
    [FollowAccept, { ...base, type: "FollowAccept", follower: other }],
    [FollowReject, { ...base, type: "FollowReject", follower: other }],
    [Unfollow, { ...base, type: "Unfollow", followee: other }],
    [Delete, {
        ...base,
        type: "Delete",
        deleted_type: "Note",
        deleted: "02e1e3b2-cb1f-4e4a-b82e-98866bee5de7",
    }],
] as const;

Deno.test("the spec's examples are valid", () => {
    for (const [schema, example] of examples) {
        assertEquals(schema.safeParse(example).success, true, example.type);
    }
});

Deno.test("each schema rejects the others' examples", () => {
    for (const [schema] of examples) {
        const valid = examples.filter(([, example]) => schema.safeParse(example).success);
        assertEquals(valid.length, 1);
    }
});

Deno.test("invalid references and missing fields are rejected", () => {
    for (const [schema, example] of examples) {
        for (const key of Object.keys(example)) {
            if (schema === Delete && key === "author") continue;
            assertEquals(
                schema.safeParse({ ...example, [key]: undefined }).success,
                false,
                `${example.type} without ${key}`,
            );
        }
        assertEquals(
            schema.safeParse({ ...example, author: "bad id!" }).success,
            false,
        );
    }
});

Deno.test("a Delete without an author comes from the instance", () => {
    const [, example] = examples[4];
    assertEquals(
        Delete.safeParse({ ...example, author: undefined }).success,
        true,
    );
    assertEquals(Delete.safeParse({ ...example, author: null }).success, true);
});
