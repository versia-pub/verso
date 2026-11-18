import { assertEquals } from "@std/assert";
import { Polls, Vote } from "./polls.ts";

const base = {
    id: "3e7e4750-afd4-4d99-a256-02f0710a0520",
    created_at: "2021-01-01T00:00:00.000Z",
    author: "6e0204a2-746c-4972-8602-c4f37fc63bbe",
};
const note = "otherexample.org:fmKZ763jzIU8";

// The spec's examples, one per entity.
const examples = [
    [Vote, { ...base, type: "pub.versia:polls/Vote", poll: note, option: 1 }],
] as const;

Deno.test("the spec's examples are valid", () => {
    for (const [schema, example] of examples) {
        assertEquals(schema.safeParse(example).success, true, example.type);
    }
});

Deno.test("invalid references and missing fields are rejected", () => {
    for (const [schema, example] of examples) {
        for (const key of Object.keys(example)) {
            assertEquals(
                schema.safeParse({ ...example, [key]: undefined }).success,
                false,
                `${example.type} without ${key}`,
            );
        }

        assertEquals(schema.safeParse({ ...example, author: "bad id!" }).success, false);
    }
});

// The spec's example.
const poll = {
    options: [
        { "text/plain": { content: "Red", remote: false } },
        { "text/plain": { content: "Blue", remote: false } },
        { "text/plain": { content: "Green", remote: false } },
    ],
    votes: [9, 5, 0],
    multiple_choice: false,
    expires_at: "2021-01-04T00:00:00.000Z",
};

Deno.test("a poll's options are text, and its votes are counts", () => {
    assertEquals(Polls.safeParse(poll).success, true);
    assertEquals(Polls.safeParse({ ...poll, expires_at: undefined }).success, true);

    const image = { "image/png": { content: "https://cdn.example.org/red.png", remote: true } };
    assertEquals(Polls.safeParse({ ...poll, options: [image] }).success, false);
    assertEquals(Polls.safeParse({ ...poll, votes: [9, -1, 0] }).success, false);
    assertEquals(Polls.safeParse({ ...poll, votes: undefined }).success, false);
    assertEquals(Polls.safeParse({ ...poll, multiple_choice: undefined }).success, false);

    const [, vote] = examples[0];
    assertEquals(Vote.safeParse({ ...vote, option: -1 }).success, false);
});
