import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { findMedia, type RemoteMedia, saveRemoteMedia } from "./media_queries.ts";
import { renderAttachment } from "./render.ts";

/** Another instance's file, as Mastodon's API describes it. */
const rendered = async (media: RemoteMedia) => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const row = await findMedia(
        test.ctx,
        await saveRemoteMedia(test.ctx, "b.example", null, media),
    );
    if (row === undefined) throw new Error("The file wasn't kept");

    return renderAttachment(test.ctx, row);
};

Deno.test("another instance's file is at its own URL", async () => {
    const attachment = await rendered({
        url: "https://b.example/bob.png",
        mediaType: "image/png",
        width: 64,
        height: 48,
        description: "Bob, smiling",
    });

    assertEquals(attachment, {
        id: attachment.id,
        type: "image",
        url: "https://b.example/bob.png",
        preview_url: null,
        remote_url: "https://b.example/bob.png",
        meta: { original: { width: 64, height: 48, size: "64x48", aspect: 64 / 48 } },
        description: "Bob, smiling",
        blurhash: null,
    });
});

Deno.test("another instance's file is of the kind its type says", async () => {
    for (
        const [mediaType, type] of [
            ["video/mp4", "video"],
            ["audio/ogg", "audio"],
            ["application/zip", "unknown"],
        ]
    ) {
        const url = "https://b.example/file";
        assertEquals((await rendered({ url, mediaType })).type, type, mediaType);
    }
});

Deno.test("a size of nothing isn't given", async () => {
    const url = "https://b.example/bob.png";

    assertEquals(
        (await rendered({ url, mediaType: "image/png", width: 0, height: 48 })).meta,
        null,
    );
    assertEquals(
        (await rendered({ url, mediaType: "image/png", width: 64, height: 0 })).meta,
        null,
    );
    assertEquals((await rendered({ url, mediaType: "image/png", width: 64 })).meta, null);
});
