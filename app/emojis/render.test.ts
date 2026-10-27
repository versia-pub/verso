import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import type { LocalEmoji, ShownEmoji } from "./emoji_queries.ts";
import { renderEmojis, renderVersiaEmoji } from "./render.ts";

const emoji: ShownEmoji = {
    shortcode: "blob",
    category: "Blobs",
    instance_id: null,
    url: null,
    media_type: "image/gif",
    sha256: null,
    preview_sha256: null,
    processed_at: null,
};

Deno.test("an emoji Verso stores is shown once processed, with its preview as its still, in its group", async () => {
    await using test = await createTestContext();
    const processed_at = test.clock.now();

    assertEquals(
        renderEmojis(test.ctx, [{ ...emoji, sha256: "ab", preview_sha256: "cd", processed_at }]),
        [{
            shortcode: "blob",
            url: "https://social.example/media/ab",
            static_url: "https://social.example/media/cd",
            visible_in_picker: true,
            category: "Blobs",
        }],
    );
    assertEquals(
        renderEmojis(test.ctx, [{ ...emoji, sha256: "ab", processed_at }])[0]?.static_url,
        "https://social.example/media/ab",
    );

    // Not processed yet, or processing failed.
    assertEquals(renderEmojis(test.ctx, [{ ...emoji, sha256: "ab", preview_sha256: "cd" }]), []);
    assertEquals(renderEmojis(test.ctx, [{ ...emoji, processed_at }]), []);
});

Deno.test("a remote emoji is shown at its URL, which is its still too, and not in the picker", async () => {
    await using test = await createTestContext();
    const url = "https://b.example/blob.gif";

    const [shown] = renderEmojis(test.ctx, [{ ...emoji, instance_id: "b", url, sha256: "ab" }]);
    assertEquals([shown?.url, shown?.static_url, shown?.visible_in_picker], [url, url, false]);
});

Deno.test("a local emoji is shown with whose it is and its alt text, and no URLs until processed", async () => {
    await using test = await createTestContext();
    const local: LocalEmoji = { ...emoji, id: "e", account_id: "alice", description: "A blob" };

    assertEquals(renderVersiaEmoji(test.ctx, local), {
        id: "e",
        shortcode: "blob",
        url: null,
        static_url: null,
        visible_in_picker: true,
        category: "Blobs",
        global: false,
        description: "A blob",
    });

    const processed = {
        ...local,
        sha256: "ab",
        preview_sha256: "cd",
        processed_at: test.clock.now(),
    };
    const shown = renderVersiaEmoji(test.ctx, { ...processed, account_id: null });
    assertEquals([shown.url, shown.static_url, shown.global], [
        "https://social.example/media/ab",
        "https://social.example/media/cd",
        true,
    ]);
});
