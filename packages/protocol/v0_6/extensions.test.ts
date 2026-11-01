import { assertEquals } from "@std/assert";
import { CustomEmojis } from "./custom_emojis.ts";
import { Dislike, Like } from "./likes.ts";
import { Polls, Vote } from "./polls.ts";
import { Reaction } from "./reactions.ts";
import { Report } from "./reports.ts";
import { Share } from "./share.ts";

const base = {
    id: "3e7e4750-afd4-4d99-a256-02f0710a0520",
    created_at: "2021-01-01T00:00:00.000Z",
    author: "6e0204a2-746c-4972-8602-c4f37fc63bbe",
};
const note = "otherexample.org:fmKZ763jzIU8";

// The spec's examples, one per entity.
const examples = [
    [Like, { ...base, type: "pub.versia:likes/Like", liked: note }],
    [Dislike, { ...base, type: "pub.versia:likes/Dislike", disliked: note }],
    [Share, { ...base, type: "pub.versia:share/Share", shared: note }],
    [Reaction, { ...base, type: "pub.versia:reactions/Reaction", object: note, content: "😀" }],
    [Vote, { ...base, type: "pub.versia:polls/Vote", poll: note, option: 1 }],
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
            assertEquals(
                schema.safeParse({ ...example, [key]: undefined }).success,
                false,
                `${example.type} without ${key}`,
            );
        }

        assertEquals(schema.safeParse({ ...example, author: "bad id!" }).success, false);
    }
});

Deno.test("a Reaction can't be empty", () => {
    const [, example] = examples[3];

    assertEquals(Reaction.safeParse({ ...example, content: "" }).success, false);
});

const emoji = (name: string, type = "image/png") => ({
    emojis: [{
        name,
        content: {
            [type]: {
                content: "https://cdn.example.org/emojis/wave_cat.png",
                remote: true,
                description: "A cat waving hello.",
            },
        },
    }],
});

Deno.test("custom emojis are wrapped in one character each side that isn't in their name", () => {
    for (const name of [":wave_cat:", ":Wave-Cat2:", "[x]", "👋cat👋"]) {
        assertEquals(CustomEmojis.safeParse(emoji(name)).success, true, name);
    }

    for (const name of ["wave_cat", ":wave_cat", "::wave::", ":wave cat:", "::", "_cat_", ":"]) {
        assertEquals(CustomEmojis.safeParse(emoji(name)).success, false, name);
    }
});

Deno.test("a custom emoji must be an image", () => {
    assertEquals(CustomEmojis.safeParse(emoji(":wave_cat:", "text/plain")).success, false);
    assertEquals(CustomEmojis.safeParse({ emojis: [] }).success, true);
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

    const [, vote] = examples[4];
    assertEquals(Vote.safeParse({ ...vote, option: -1 }).success, false);
});

// The spec's example of a Report, which is transient, so it has no id.
const report = {
    type: "pub.versia:reports/Report",
    created_at: "2021-01-01T00:00:00.000Z",
    author: "6f3001a1-641b-4763-a9c4-a089852eec84",
    reported: [
        "test.com:46f936a3-9a1e-4b02-8cde-0902a89769fa",
        "test.com:213d7c56-fb9b-4646-a4d2-7d70aa7d106a",
    ],
    tags: ["spam", "harassment"],
    comment: "This is spam.",
};

Deno.test("a Report may be anonymous, and needs only what it reports and its tags", () => {
    assertEquals(Report.safeParse(report).success, true);
    for (const key of ["author", "comment"]) {
        assertEquals(Report.safeParse({ ...report, [key]: undefined }).success, true, key);
        assertEquals(Report.safeParse({ ...report, [key]: null }).success, true, key);
    }

    for (const key of ["type", "created_at", "reported", "tags"]) {
        assertEquals(Report.safeParse({ ...report, [key]: undefined }).success, false, key);
    }
    assertEquals(Report.safeParse({ ...report, reported: ["bad id!"] }).success, false);
    assertEquals(Report.safeParse({ ...report, author: "bad id!" }).success, false);
});
