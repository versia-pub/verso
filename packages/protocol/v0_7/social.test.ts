import { assertEquals } from "@std/assert";
import { Note } from "./social.ts";

// The spec's example.
const note = {
    id: "1j0q0j3wb4v0hgtw6w",
    type: "pub.versia:social/Note",
    created_at: "2024-06-19T01:07:44Z",
    attachments: [
        {
            url: "https://cdn.example.com/68c02dd11c179ef4d170b05393f6e72133dd0ad733f40d41b42363d8784e8d5d/fire.txt",
            media_type: "text/plain",
            size: 8,
            hash: "68c02dd11c179ef4d170b05393f6e72133dd0ad733f40d41b42363d8784e8d5d",
        },
    ],
    author: "versia.example:1htw66x9z69ne6ag6x",
    category: "microblog",
    content: "<p>In the next versia-fe update: account settings, finally!</p>",
    device: { name: "Example Client", version: "1.0.0", url: "https://client.example" },
    extensions: { "pub.versia:custom_emojis": { emojis: [] } },
    visibility: "public",
    is_sensitive: false,
    mentions: [],
    previews: [],
    subject: "Versia development",
    url: "https://versia.example/notes/1j0q0j3wb4v0hgtw6w",
};

Deno.test("the spec's example Note is valid", () => {
    assertEquals(Note.safeParse(note).success, true);
});

Deno.test("a Note needs its type, author, visibility, attachments, mentions and previews", () => {
    for (
        const key of [
            "id",
            "type",
            "created_at",
            "author",
            "visibility",
            "is_sensitive",
            "attachments",
            "mentions",
            "previews",
        ]
    ) {
        assertEquals(Note.safeParse({ ...note, [key]: undefined }).success, false, key);
    }

    assertEquals(Note.safeParse({ ...note, type: "Note" }).success, false);
});

Deno.test("visibility is one of the four values", () => {
    for (const visibility of ["public", "unlisted", "subscribers", "mentions"]) {
        assertEquals(Note.safeParse({ ...note, visibility }).success, true, visibility);
    }

    for (const visibility of ["followers", "direct", "Public"]) {
        assertEquals(Note.safeParse({ ...note, visibility }).success, false, visibility);
    }
});

Deno.test("an unknown category is read as absent", () => {
    assertEquals(Note.parse(note).category, "microblog");
    assertEquals(Note.parse({ ...note, category: "podcast" }).category, undefined);
    assertEquals(Note.parse({ ...note, category: null }).category, undefined);
    assertEquals(Note.safeParse({ ...note, category: 1 }).success, false);
});

Deno.test("references must include their domain", () => {
    for (const key of ["author", "quoting", "replies_to"]) {
        assertEquals(
            Note.safeParse({ ...note, [key]: "1htw66x9z69ne6ag6x" }).success,
            false,
            key,
        );
        assertEquals(
            Note.safeParse({ ...note, [key]: "b.example:1htw66x9z69ne6ag6x" }).success,
            true,
            key,
        );
    }

    assertEquals(Note.safeParse({ ...note, mentions: ["1htw66x9z69ne6ag6x"] }).success, false);
});

Deno.test("links are http or https", () => {
    assertEquals(Note.safeParse({ ...note, url: "javascript:alert(1)" }).success, false);
    assertEquals(
        Note.safeParse({ ...note, previews: [{ link: "ftp://a.example", title: "A" }] }).success,
        false,
    );
});
