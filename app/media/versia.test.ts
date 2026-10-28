import { assertEquals } from "@std/assert";
import { remoteFile, remotePicture } from "./versia.ts";

Deno.test("a version that isn't at a web address isn't taken, even if it reads as one", () => {
    assertEquals(
        remotePicture({
            "image/png": { content: "https://b.example/inline.png", remote: false },
            "image/webp": { content: "https://b.example/bob.webp", remote: true },
        })?.url,
        "https://b.example/bob.webp",
    );
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

    const type = `application/${"a".repeat(255 - 12)}`;
    assertEquals(remoteFile({ [type]: { content: url, remote: true } })?.mediaType, type);
    assertEquals(remoteFile({ [`${type}a`]: { content: url, remote: true } }), null);
});
