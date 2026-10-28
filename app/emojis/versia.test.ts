import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import type { ShownEmoji } from "./emoji_queries.ts";
import { emojiExtensions, remoteEmojisOf } from "./versia.ts";

/** An emoji named `name`, with a picture at `url` of `type`. */
const emoji = (name: string, url = "https://b.example/blob.png", type = "image/png") => ({
    name,
    content: { [type]: { content: url, remote: true, width: 32 } },
});

const extensions = (...emojis: object[]) => ({ "pub.versia:custom_emojis": { emojis } });

/** The shortcode and picture URL of each emoji stored. */
const kept = (value: Parameters<typeof remoteEmojisOf>[0]) =>
    remoteEmojisOf(value).map((each) => [each.shortcode, each.picture.url]);

Deno.test("an entity's emojis are kept by their names, without the colons", () => {
    const [blob] = remoteEmojisOf(extensions(emoji(":blob:")));
    assertEquals([blob?.shortcode, blob?.picture.mediaType, blob?.picture.width], [
        "blob",
        "image/png",
        32,
    ]);
    assertEquals(kept(extensions(emoji(":blob:"), emoji(":cat-2:", "https://b.example/cat.png"))), [
        ["blob", "https://b.example/blob.png"],
        ["cat-2", "https://b.example/cat.png"],
    ]);
});

Deno.test("emojis clients can't show, named again, named without colons or too long are left out", () => {
    assertEquals(
        kept(extensions(
            emoji(":blob:"),
            emoji(":blob:", "https://b.example/other.png"),
            emoji("!bang!"),
            emoji(`:${"a".repeat(101)}:`),
            emoji(":vector:", "https://b.example/vector.svg", "image/svg+xml"),
            { name: ":here:", content: { "image/png": { content: "here.png", remote: false } } },
        )),
        [["blob", "https://b.example/blob.png"]],
    );
    assertEquals(kept(extensions(emoji(`:${"a".repeat(100)}:`))), [[
        "a".repeat(100),
        "https://b.example/blob.png",
    ]]);
});

Deno.test("an entity has at most 100 emojis, and a malformed extension has none", () => {
    const many = Array.from({ length: 101 }, (_, index) => emoji(`:e${index}:`));
    assertEquals(remoteEmojisOf(extensions(...many)).length, 100);

    assertEquals(remoteEmojisOf(undefined), []);
    assertEquals(remoteEmojisOf({}), []);
    assertEquals(remoteEmojisOf({ "pub.versia:custom_emojis": { emojis: "blob" } }), []);
    // A name without anything around it makes the whole extension malformed.
    assertEquals(remoteEmojisOf(extensions(emoji(":blob:"), emoji("blob"))), []);
});

Deno.test("emojis are sent by name, with their pictures, once ready", async () => {
    await using test = await createTestContext();
    const emoji: ShownEmoji = {
        shortcode: "blob",
        category: null,
        instance_id: null,
        url: null,
        media_type: "image/gif",
        sha256: null,
        preview_sha256: null,
        processed_at: null,
    };
    const sent = (picture: Partial<ShownEmoji>) =>
        emojiExtensions(test.ctx, [{ ...emoji, ...picture }]);

    assertEquals(sent({ url: "https://a.example/blob.gif" }), {
        "pub.versia:custom_emojis": {
            emojis: [{
                name: ":blob:",
                content: { "image/gif": { content: "https://a.example/blob.gif", remote: true } },
            }],
        },
    });
    assertEquals(
        sent({ url: null, sha256: "ab", processed_at: test.clock.now() }),
        {
            "pub.versia:custom_emojis": {
                emojis: [{
                    name: ":blob:",
                    content: {
                        "image/gif": { content: "https://social.example/media/ab", remote: true },
                    },
                }],
            },
        },
    );

    // Stored, but not processed, or processing failed.
    assertEquals(sent({ url: null, sha256: "ab" }), undefined);
    assertEquals(sent({ url: null, processed_at: test.clock.now() }), undefined);
    assertEquals(emojiExtensions(test.ctx, []), undefined);
});
