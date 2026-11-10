import { assertEquals } from "@std/assert";
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

Deno.test("another instance's file is served by Verso once cached, and at its own URL until then", async () => {
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
    assertEquals(await shown(), { url, preview_url: null, remote_url: url });

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
