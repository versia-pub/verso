import { assertAlmostEquals, assertEquals } from "@std/assert";
import { decode, isBlurhashValid } from "blurhash";
import { thumbHashToApproximateAspectRatio, thumbHashToAverageRGBA } from "thumbhash";
import { blurhashOf, type Pixels, thumbhashOf } from "./image_hashes.ts";

/** A picture `width` by `height`, all of one colour. */
const solid = (width: number, height: number, [r, g, b, a]: number[]): Pixels => ({
    width,
    height,
    rgba: new Uint8Array(width * height * 4).map((_, i) => [r, g, b, a][i % 4]),
});

Deno.test("a ThumbHash is in base64, with the picture's colour and shape", () => {
    const hash = thumbhashOf(solid(100, 50, [255, 0, 0, 255]));
    const bytes = Uint8Array.fromBase64(hash);

    assertEquals(bytes.toBase64(), hash);
    const average = thumbHashToAverageRGBA(bytes);
    assertAlmostEquals(average.r, 1, 0.02);
    assertAlmostEquals(average.g, 0, 0.02);
    assertAlmostEquals(average.b, 0, 0.02);
    assertAlmostEquals(average.a, 1, 0.02);
    // The shape is only roughly kept, but a wide picture stays wider than a tall one.
    const tall = Uint8Array.fromBase64(thumbhashOf(solid(50, 100, [255, 0, 0, 255])));
    assertEquals(thumbHashToApproximateAspectRatio(bytes) > 1.5, true);
    assertEquals(thumbHashToApproximateAspectRatio(tall) < 0.7, true);

    // A see-through one says so.
    const clear = thumbHashToAverageRGBA(
        Uint8Array.fromBase64(thumbhashOf(solid(10, 10, [0, 0, 255, 0]))),
    );
    assertAlmostEquals(clear.a, 0, 0.02);
});

Deno.test("a BlurHash has four components each way, and the picture's colour", () => {
    const hash = blurhashOf(solid(40, 30, [0, 0, 255, 255]));

    assertEquals(isBlurhashValid(hash).result, true);
    // The first character says how many components there are: (4 - 1) + (4 - 1) * 9.
    assertEquals(hash[0], "U");
    const [r, g, b] = decode(hash, 1, 1);
    assertEquals([r, g, b], [0, 0, 255]);
});
