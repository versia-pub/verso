import { assertEquals } from "@std/assert";
import { remotePicture } from "./versia.ts";

Deno.test("a version that isn't at a web address isn't taken, even if it reads as one", () => {
    assertEquals(
        remotePicture({
            "image/png": { content: "https://b.example/inline.png", remote: false },
            "image/webp": { content: "https://b.example/bob.webp", remote: true },
        })?.url,
        "https://b.example/bob.webp",
    );
});
