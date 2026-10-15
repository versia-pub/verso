import { assertEquals } from "@std/assert";
import { User } from "./user.ts";

// The spec's example, with `remote` added to each ContentFormat: the example leaves it out,
// but the ContentFormat definition requires it.
const user = {
    id: "018ec082-0ae1-761c-b2c5-22275a611771",
    type: "User",
    created_at: "2024-04-09T01:38:51.743Z",
    avatar: {
        "image/png": {
            content: "https://avatars.githubusercontent.com/u/30842467?v=4",
            remote: true,
        },
    },
    bio: {
        "text/html": { content: "<p>🌸🌸🌸</p>", remote: false },
        "text/plain": { content: "🌸🌸🌸", remote: false },
    },
    display_name: "April The Pink (limited Sand Edition)",
    extensions: { "pub.versia:custom_emojis": { emojis: [] } },
    fields: [
        {
            key: { "text/html": { content: "<p>Pronouns</p>", remote: false } },
            value: { "text/html": { content: "<p>It/its</p>", remote: false } },
        },
    ],
    header: null,
    indexable: false,
    manually_approves_followers: false,
    username: "aprl",
};

Deno.test("the spec's example User is valid", () => {
    assertEquals(User.safeParse(user).success, true);
});

Deno.test("invalid Users are rejected", () => {
    const text = { "text/plain": { content: "hi", remote: false } };

    for (
        const bad of [
            { ...user, type: "Note" },
            { ...user, username: "has space" },
            { ...user, username: "" },
            { ...user, fields: undefined },
            { ...user, indexable: undefined },
            { ...user, avatar: text },
            { ...user, header: text },
            { ...user, bio: user.avatar },
            { ...user, fields: [{ key: user.avatar, value: text }] },
            {
                ...user,
                avatar: { "image/png": { content: "https://a.example/a.png" } },
            },
        ]
    ) {
        assertEquals(User.safeParse(bad).success, false);
    }
});
