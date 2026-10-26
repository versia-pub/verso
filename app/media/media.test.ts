import { assertEquals } from "@std/assert";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { deleteMedia, findMedia, saveRemoteMedia } from "./media_queries.ts";

const picture = {
    url: "https://b.example/bob.png",
    mediaType: "image/png",
    size: 1234,
    sha256: "ab".repeat(32),
    width: 64,
    height: 48,
    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    description: "Bob, smiling",
};

Deno.test("a remote file is kept with what its instance said about it", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");

    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture);

    assertEquals(await findMedia(test.ctx, id), {
        id,
        instance_id: "b.example",
        url: picture.url,
        media_type: "image/png",
        size: 1234,
        sha256: picture.sha256,
        width: 64,
        height: 48,
        thumbhash: picture.thumbhash,
        description: "Bob, smiling",
        created_at: test.clock.now(),
        account_id: null,
        upload_sha256: null,
        processed_at: null,
        preview_sha256: null,
        preview_width: null,
        preview_height: null,
        blurhash: null,
        focus_x: null,
        focus_y: null,
        fit_width: null,
        fit_height: null,
    });
});

Deno.test("a remote file saved over another keeps its id, and loses what it leaves out", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture);

    const again = await saveRemoteMedia(test.ctx, "b.example", id, {
        url: "https://b.example/bob.webp",
        mediaType: "image/webp",
    });

    assertEquals(again, id);
    const row = await findMedia(test.ctx, id);
    assertEquals(
        [row?.url, row?.media_type, row?.size, row?.width, row?.thumbhash, row?.description],
        ["https://b.example/bob.webp", "image/webp", null, null, null, null],
    );
    assertEquals((await test.ctx.db.selectFrom("media").select("id").execute()).length, 1);
});

Deno.test("a deleted file is gone", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture);

    await deleteMedia(test.ctx, id);

    assertEquals(await findMedia(test.ctx, id), undefined);
});
