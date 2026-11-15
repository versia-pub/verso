import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { findMedia } from "./media_queries.ts";
import { pictureTypes } from "./uploads.ts";
import { remoteMedia, remotePicture, versiaMedia } from "./versia.ts";

Deno.test("a version that isn't at a web address isn't taken, even if it reads as one", () => {
    assertEquals(
        remotePicture({
            "image/png": { content: "https://b.example/inline.png", remote: false },
            "image/webp": { content: "https://b.example/bob.webp", remote: true },
        })?.url,
        "https://b.example/bob.webp",
    );
});

Deno.test("a remote media's hash is stored in lowercase", () => {
    const hash = "AB".repeat(32);

    const media = remotePicture({
        "image/webp": { content: "https://b.example/bob.webp", remote: true, hash },
    });

    assertEquals(media?.sha256, hash.toLowerCase());
});

Deno.test("what is too large to store is left out of remote media, or skips its version", () => {
    const url = "https://b.example/bob.webp";
    const largest = 2 ** 31 - 1;
    const kept = remotePicture({
        "image/webp": { content: url, remote: true, size: largest, width: largest, height: 1 },
    });

    assertEquals([kept?.size, kept?.width, kept?.height], [largest, largest, 1]);

    const tooLarge = remotePicture({
        "image/webp": {
            content: url,
            remote: true,
            size: largest + 1,
            width: largest + 1,
            height: largest + 1,
            thumbhash: "a".repeat(101),
        },
    });

    assertEquals(
        [tooLarge?.url, tooLarge?.size, tooLarge?.width, tooLarge?.height, tooLarge?.thumbhash],
        [url, undefined, undefined, undefined, undefined],
    );
    assertEquals(
        remotePicture({ "image/webp": { content: url, remote: true, thumbhash: "a".repeat(100) } })
            ?.thumbhash,
        "a".repeat(100),
    );

    const longUrl = `https://b.example/${"a".repeat(2048 - 18)}`;
    assertEquals(remotePicture({ "image/webp": { content: longUrl, remote: true } })?.url, longUrl);
    assertEquals(
        remotePicture({
            "image/png": { content: `${longUrl}a`, remote: true },
            "image/webp": { content: url, remote: true },
        })?.url,
        url,
    );
});

const pictures = (mediaType: string) => pictureTypes.has(mediaType);

Deno.test("v0.7 media is stored with what it says, and left out if its type isn't taken", () => {
    const hash = "AB".repeat(32);

    assertEquals(
        remoteMedia({
            url: "https://b.example/bob.webp",
            media_type: "image/webp",
            description: "Bob",
            size: 1234,
            hash: hash.toLowerCase(),
            thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
            width: 64,
            height: 48,
        }, pictures),
        {
            url: "https://b.example/bob.webp",
            mediaType: "image/webp",
            description: "Bob",
            size: 1234,
            sha256: hash.toLowerCase(),
            thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
            width: 64,
            height: 48,
        },
    );
    assertEquals(
        remoteMedia({ url: "https://b.example/sea.svg", media_type: "image/svg+xml" }, pictures),
        null,
    );
    assertEquals(remoteMedia(undefined, pictures), null);
    assertEquals(remoteMedia(null, pictures), null);
});

Deno.test("v0.7 media that is too large to store is left out, or isn't taken", () => {
    const url = "https://b.example/bob.webp";
    const largest = 2 ** 31 - 1;
    const media = { url, media_type: "image/webp" };

    const kept = remoteMedia({ ...media, size: largest, width: largest, height: 1 }, pictures);
    assertEquals([kept?.size, kept?.width, kept?.height], [largest, largest, 1]);

    const tooLarge = remoteMedia({
        ...media,
        size: largest + 1,
        width: largest + 1,
        height: largest + 1,
        thumbhash: "a".repeat(101),
    }, pictures);
    assertEquals(
        [tooLarge?.url, tooLarge?.size, tooLarge?.width, tooLarge?.height, tooLarge?.thumbhash],
        [url, undefined, undefined, undefined, undefined],
    );

    const longUrl = `https://b.example/${"a".repeat(2048 - 18)}`;
    assertEquals(remoteMedia({ ...media, url: longUrl }, pictures)?.url, longUrl);
    assertEquals(remoteMedia({ ...media, url: `${longUrl}a` }, pictures), null);

    const type = `application/${"a".repeat(255 - 12)}`;
    assertEquals(remoteMedia({ url, media_type: type }, () => true)?.mediaType, type);
    assertEquals(remoteMedia({ url, media_type: `${type}a` }, () => true), null);
});

Deno.test("local media is given to v0.7 as its file, once processed", async () => {
    await using test = await createTestContext();
    const insert = async (changes: { processed_at: Date | null; sha256: string | null }) => {
        const id = test.ctx.ids();
        await test.ctx.db.insertInto("media")
            .values({
                id,
                instance_id: null,
                media_type: "image/png",
                preview_sha256: "c".repeat(64),
                size: 10,
                width: 64,
                height: 48,
                thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                description: "Me",
                created_at: test.clock.now(),
                ...changes,
            })
            .execute();
        const row = await findMedia(test.ctx, id);
        if (row === undefined) throw new Error("The media wasn't saved");

        return row;
    };

    const processed = await insert({ processed_at: test.clock.now(), sha256: "ab".repeat(32) });
    assertEquals(versiaMedia(test.ctx, processed), {
        url: `https://social.example/media/${"ab".repeat(32)}`,
        media_type: "image/png",
        description: "Me",
        size: 10,
        hash: "ab".repeat(32),
        thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
        width: 64,
        height: 48,
    });

    assertEquals(
        versiaMedia(test.ctx, await insert({ processed_at: null, sha256: "ab" })),
        undefined,
    );
    assertEquals(
        versiaMedia(test.ctx, await insert({ processed_at: test.clock.now(), sha256: null })),
        undefined,
    );
});
