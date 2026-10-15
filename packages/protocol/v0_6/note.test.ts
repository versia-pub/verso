import { assertEquals } from "@std/assert";
import { Note } from "./note.ts";

// The spec's example. Its second attachment is missing a comma after `duration` in the spec,
// which makes it invalid JSON; that is fixed here.
const note = {
    id: "01902e09-0f8b-72de-8ee3-9afc0cf5eae1",
    type: "Note",
    created_at: "2024-06-19T01:07:44.139Z",
    attachments: [
        {
            "image/png": {
                content:
                    "https://cdn.versia.social/29e810bf4707fef373d886af322089d5db300fce66e4e073efc26827f10825f6/image.webp",
                remote: true,
                thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                description: null,
                fps: null,
                duration: null,
                height: 960,
                size: 221275,
                hash: "967b8e86d8708c6283814f450efcbd3be94d3d24ca9a7ab435b2ff8b51dcbc21",
                width: 639,
            },
        },
        {
            "text/plain": {
                content:
                    "https://cdn.lysand.org/68c02dd11c179ef4d170b05393f6e72133dd0ad733f40d41b42363d8784e8d5d/fire.txt",
                remote: true,
                description: null,
                thumbhash: null,
                width: null,
                height: null,
                fps: null,
                duration: null,
                size: 8,
                hash: "68c02dd11c179ef4d170b05393f6e72133dd0ad733f40d41b42363d8784e8d5d",
            },
        },
    ],
    author: "018eb863-753f-76ff-83d6-fd590de7740a",
    category: "microblog",
    content: {
        "text/html": {
            content: "<p>In the next versia-fe update: account settings, finally!</p>",
            remote: false,
        },
        "text/plain": {
            content: "In the next versia-fe update: account settings, finally!",
            remote: false,
        },
    },
    device: {
        name: "Megalodon for Android",
        version: "1.3.89",
        url: "https://sk22.github.io/megalodon",
    },
    extensions: { "pub.versia:custom_emojis": { emojis: [] } },
    group: "public",
    is_sensitive: false,
    mentions: [],
    subject: "Versia development",
    previews: [],
    quotes: null,
    replies_to: null,
};

Deno.test("the spec's example Note is valid", () => {
    assertEquals(Note.safeParse(note).success, true);
});

Deno.test("a minimal Note with remote references is valid", () => {
    assertEquals(
        Note.safeParse({
            id: "1",
            type: "Note",
            created_at: "2024-06-19T01:07:44Z",
            attachments: [],
            author: "social.example:abc",
            group: "groups.example:g1",
            is_sensitive: true,
            mentions: ["a.example:u1", "u2"],
            previews: [{ link: "https://example.com", title: "Example" }],
        }).success,
        true,
    );
});

Deno.test("invalid Notes are rejected", () => {
    const local = { "image/png": { content: "AAAA", remote: false } };
    const remoteText = {
        "text/plain": { content: "https://a.example/t", remote: true },
    };

    for (
        const bad of [
            { ...note, type: "User" },
            { ...note, author: undefined },
            { ...note, author: "bad id!" },
            { ...note, mentions: ["host:"] },
            { ...note, is_sensitive: undefined },
            { ...note, category: "podcast" },
            { ...note, attachments: [local] },
            { ...note, content: remoteText },
            {
                ...note,
                content: { "image/png": note.attachments[0]["image/png"] },
            },
            {
                ...note,
                previews: [{ link: "javascript:alert(1)", title: "x" }],
            },
            { ...note, device: { name: "x", url: "ftp://a.example" } },
        ]
    ) {
        assertEquals(Note.safeParse(bad).success, false, JSON.stringify(bad));
    }
});
