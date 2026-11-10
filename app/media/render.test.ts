import { assert, assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { findMedia, type RemoteMedia } from "./media_queries.ts";
import { saveRemoteMedia } from "./remote_cache.ts";
import { renderAttachment } from "./render.ts";

/** Remote media, as Mastodon's API renders it. */
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

Deno.test("another instance's file is at the media proxy until cached", async () => {
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
        url: `https://social.example/media/proxy/${attachment.id}`,
        preview_url: `https://social.example/media/proxy/${attachment.id}/small`,
        remote_url: "https://b.example/bob.png",
        meta: { original: { width: 64, height: 48, size: "64x48", aspect: 64 / 48 } },
        description: "Bob, smiling",
        blurhash: null,
    });

    // Only images have a preview.
    const video = await rendered({ url: "https://b.example/bob.mp4", mediaType: "video/mp4" });
    assertEquals([video.url, video.preview_url], [
        `https://social.example/media/proxy/${video.id}`,
        null,
    ]);
});

Deno.test("another instance's file that won't be cached is at its own URL", async () => {
    const url = "https://b.example/notes.zip";
    const zip = await rendered({ url, mediaType: "application/zip" });
    assertEquals([zip.url, zip.preview_url, zip.remote_url], [url, null, url]);

    await using test = await createTestContext({ settings: { cacheRemoteMedia: false } });
    await createInstance(test.ctx, "b.example");
    const id = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/bob.png",
        mediaType: "image/png",
    });
    const row = await findMedia(test.ctx, id);
    assert(row);
    const uncached = renderAttachment(test.ctx, row);
    assertEquals([uncached.url, uncached.preview_url], ["https://b.example/bob.png", null]);
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

Deno.test("another instance's file is served by Verso once cached, and at its own URL if that failed", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const url = "https://b.example/bob.png";
    const id = await saveRemoteMedia(test.ctx, "b.example", null, { url, mediaType: "image/png" });
    const shown = async () => {
        const row = await findMedia(test.ctx, id);
        if (row === undefined) throw new Error("The file wasn't kept");

        const { url, preview_url, remote_url } = renderAttachment(test.ctx, row);
        return { url, preview_url, remote_url };
    };

    // Not cached yet.
    assertEquals(await shown(), {
        url: `https://social.example/media/proxy/${id}`,
        preview_url: `https://social.example/media/proxy/${id}/small`,
        remote_url: url,
    });

    await test.ctx.db.updateTable("media")
        .set({ sha256: "ab", preview_sha256: "cd", processed_at: test.clock.now() })
        .execute();
    assertEquals(await shown(), {
        url: "https://social.example/media/ab",
        preview_url: "https://social.example/media/cd",
        remote_url: url,
    });

    // Caching failed.
    await test.ctx.db.updateTable("media").set({ sha256: null, preview_sha256: null }).execute();
    assertEquals(await shown(), { url, preview_url: null, remote_url: url });
});
