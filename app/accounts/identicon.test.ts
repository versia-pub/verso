import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { decode } from "fast-png";
import { identicon, identiconBanner } from "./identicon.ts";

/** The picture's size, palette and pixels' palette indices row by row, with its CRCs checked. */
const decodePng = (png: Uint8Array) => {
    const { width, height, palette = [], data, channels } = decode(png, { checkCrc: true });
    assertEquals(channels, 1, "paletted");

    return {
        width,
        height,
        palette,
        pixels: Array.from(
            { length: height },
            (_, y) => [...data.subarray(y * width, (y + 1) * width)],
        ),
    };
};

Deno.test("an identicon is a 420×420 picture, the same each time for the same seed", async () => {
    const image = decodePng(await identicon("alice"));

    assertEquals([image.width, image.height], [420, 420]);
    assertEquals(image.palette.length, 2);
    assertEquals(await identicon("alice"), await identicon("alice"));
});

Deno.test("an identicon is mirrored, with a blank margin", async () => {
    const { pixels } = decodePng(await identicon("alice"));

    for (const row of pixels) assertEquals(row, row.toReversed());
    assert(pixels.slice(0, 35).every((row) => row.every((index) => index === 0)));
    assert(pixels.every((row) => row.slice(0, 35).every((index) => index === 0)));
});

Deno.test("different seeds look different", async () => {
    const alice = decodePng(await identicon("alice"));
    const bob = decodePng(await identicon("bob"));

    assertNotEquals(alice.palette[1], bob.palette[1]);
    assertNotEquals(alice.pixels, bob.pixels);
});

Deno.test("a banner is 1500×500, in a pale shade of the identicon's colour", async () => {
    const avatar = decodePng(await identicon("alice"));
    const banner = decodePng(await identiconBanner("alice"));
    const [r, g, b] = banner.palette[0];

    assertEquals([banner.width, banner.height, banner.palette.length], [1500, 500, 1]);
    assert(Math.min(r, g, b) > Math.max(...avatar.palette[1]) - 60, "paler");

    // The same hue: the channels rank the same way.
    const rank = (rgb: number[]) => [0, 1, 2].toSorted((i, j) => rgb[i] - rgb[j]);
    assertEquals(rank(banner.palette[0]), rank(avatar.palette[1]));
});
