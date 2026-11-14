import { assertEquals } from "@std/assert";
import { CustomEmojis } from "./custom_emojis.ts";
import { Dislike, Like, Reaction, Share } from "./interactions.ts";
import { MigrationExtension } from "./migration.ts";
import { Polls, Vote } from "./polls.ts";

const base = {
    id: "1hrck56vbp3k1zq615",
    created_at: "2021-01-01T00:00:00Z",
    author: "example.com:1hydmskagrdtnq544w",
    target: "example.org:1hy0mxwrc92jvwqc45",
};

// The spec's examples, one per entity.
const examples = [
    [Like, { ...base, type: "pub.versia:likes/Like" }],
    [Dislike, { ...base, type: "pub.versia:likes/Dislike" }],
    [Share, { ...base, type: "pub.versia:share/Share" }],
    [Reaction, { ...base, type: "pub.versia:reactions/Reaction", content: "😀" }],
    [Vote, { ...base, type: "pub.versia:polls/Vote", options: [1] }],
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

Deno.test("every field is required, and references need their domain", () => {
    for (const [schema, example] of examples) {
        for (const key of Object.keys(example)) {
            assertEquals(
                schema.safeParse({ ...example, [key]: undefined }).success,
                false,
                `${example.type} without ${key}`,
            );
        }

        for (const key of ["author", "target"]) {
            assertEquals(
                schema.safeParse({ ...example, [key]: "1hydmskagrdtnq544w" }).success,
                false,
                `${example.type} with a bare ${key}`,
            );
        }
    }
});

Deno.test("a Reaction can't be empty", () => {
    const [, reaction] = examples[3];

    assertEquals(Reaction.safeParse({ ...reaction, content: "" }).success, false);
});

Deno.test("a Vote chooses at least one option, and none twice", () => {
    const [, vote] = examples[4];

    assertEquals(Vote.safeParse({ ...vote, options: [0, 2, 1] }).success, true);

    for (const options of [[], [1, 1], [-1], [0.5], ["1"]]) {
        assertEquals(Vote.safeParse({ ...vote, options }).success, false, JSON.stringify(options));
    }
});

// The spec's example.
const poll = {
    options: [
        { content: "Red", votes: 9 },
        { content: "Blue", votes: 5 },
        { content: "Green", votes: 0 },
    ],
    multiple_choice: false,
    expires_at: "2024-06-22T01:07:44Z",
};

Deno.test("a poll's options each have their text and their count of votes", () => {
    assertEquals(Polls.safeParse(poll).success, true);
    assertEquals(Polls.safeParse({ ...poll, expires_at: undefined, voters: 14 }).success, true);

    assertEquals(Polls.safeParse({ ...poll, multiple_choice: undefined }).success, false);
    assertEquals(Polls.safeParse({ ...poll, voters: -1 }).success, false);
    assertEquals(Polls.safeParse({ ...poll, options: [{ content: "Red" }] }).success, false);
    assertEquals(Polls.safeParse({ ...poll, options: [{ votes: 1 }] }).success, false);
    assertEquals(
        Polls.safeParse({ ...poll, options: [{ content: "Red", votes: -1 }] }).success,
        false,
    );
});

const emoji = (name: string, mediaType = "image/webp") => ({
    emojis: [{
        name,
        content: {
            url: "https://cdn.example.com/emojis/happy_face.webp",
            media_type: mediaType,
            description: "A happy emoji smiling.",
        },
    }],
});

Deno.test("custom emojis are wrapped in one character each side that isn't in their name", () => {
    for (const name of [":happy_face:", ":Happy-Face2:", "[x]", "👋cat👋"]) {
        assertEquals(CustomEmojis.safeParse(emoji(name)).success, true, name);
    }

    for (const name of ["happy_face", ":happy_face", "::happy::", ":happy face:", "::", ":"]) {
        assertEquals(CustomEmojis.safeParse(emoji(name)).success, false, name);
    }
});

Deno.test("a custom emoji must be an image", () => {
    assertEquals(CustomEmojis.safeParse(emoji(":happy_face:", "text/plain")).success, false);
    assertEquals(CustomEmojis.safeParse({ emojis: [] }).success, true);
});

Deno.test("a user's migration names where it came from and went to", () => {
    assertEquals(
        MigrationExtension.safeParse({ previous: "old.example:1jczcc0s69y0dgtfkb" }).success,
        true,
    );
    assertEquals(
        MigrationExtension.safeParse({ destination: "new.example:1hmbsv42ynr64s63kp" }).success,
        true,
    );
    assertEquals(MigrationExtension.safeParse({ previous: "1jczcc0s69y0dgtfkb" }).success, false);
});
