import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import type { ShownEmoji } from "./emoji_queries.ts";
import { renderEmojis } from "./render.ts";

const emoji: ShownEmoji = {
    shortcode: "blob",
    instance_id: null,
    url: null,
    media_type: "image/gif",
    sha256: null,
    preview_sha256: null,
    processed_at: null,
};

Deno.test("an emoji Verso stores is shown once processed, with its preview as its still", async () => {
    await using test = await createTestContext();
    const processed_at = test.clock.now();

    assertEquals(
        renderEmojis(test.ctx, [{ ...emoji, sha256: "ab", preview_sha256: "cd", processed_at }]),
        [{
            shortcode: "blob",
            url: "https://social.example/media/ab",
            static_url: "https://social.example/media/cd",
            visible_in_picker: true,
            category: null,
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
