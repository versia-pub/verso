import { assertEquals } from "@std/assert";
import { Delete } from "./delete.ts";

const base = {
    author: "6e0204a2-746c-4972-8602-c4f37fc63bbe",
    created_at: "2021-01-01T00:00:00.000Z",
};

// The spec's examples, one per entity.
const examples = [
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
    const [, example] = examples[0];

    assertEquals(
        Delete.safeParse({ ...example, author: undefined }).success,
        true,
    );
    assertEquals(Delete.safeParse({ ...example, author: null }).success, true);
});
