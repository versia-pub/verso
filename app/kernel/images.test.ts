import { assertEquals } from "@std/assert";
import { imageFormatOf } from "./images.ts";

const bytes = (...parts: (string | number[])[]) =>
    new Uint8Array(
        parts.flatMap((part) =>
            typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part
        ),
    );

/** An ISO media file's `ftyp` box, with `brands` after its major brand, and what follows it. */
const ftyp = (
    major: string,
    brands: string[],
    { after = "....meta", version = "\0\0\0\0", size = 16 + 4 * brands.length } = {},
) => bytes([0, 0, 0, size], "ftyp", major, version, brands.join(""), after);

Deno.test("a picture's format is told from how it starts", () => {
    for (
        const [format, start] of [
            ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF")],
            ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe1], "..Exif")],
            ["png", bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR")],
            ["gif", bytes("GIF89a", [1, 0, 1, 0])],
            ["gif", bytes("GIF87a", [1, 0, 1, 0])],
            ["webp", bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ")],
            // As libavif writes them, and as an animated one starts.
            ["avif", ftyp("avif", ["mif1", "miaf", "MA1B"])],
            ["avif", ftyp("avis", ["msf1", "miaf", "MA1B"])],
            // As iPhones write them, and as some others do, saying only that they're HEIF first.
            ["heic", ftyp("heic", ["mif1", "heic"])],
            ["heic", ftyp("mif1", ["mif1", "heic"])],
            ["heic", ftyp("msf1", ["msf1", "hevc"])],
            ["avif", ftyp("mif1", ["mif1", "miaf", "avif"])],
        ] as const
    ) {
        assertEquals(imageFormatOf(start), format, String(start.subarray(0, 24)));
    }
});

Deno.test("anything else isn't a picture Verso takes", () => {
    for (
        const start of [
            bytes(),
            bytes([0xff, 0xd8]),
            bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a]),
            bytes("GIF88a"),
            bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "),
            bytes("RIFX", [0x24, 0, 0, 0], "WEBP"),
            bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            bytes("%PDF-1.7"),
            bytes("II*\0"),
            bytes([0xff, 0x0a]),
            // An MP4 video, a HEIF file of no kind Verso takes, and a JPEG XL one.
            ftyp("isom", ["isom", "iso2", "mp41"]),
            ftyp("mif1", ["mif1", "miaf"]),
            bytes([0, 0, 0, 12], "JXL ", [0x0d, 0x0a, 0x87, 0x0a]),
            // Brands past the end of the box aren't its brands.
            ftyp("mif1", ["mif1"], { after: "heic" }),
            ftyp("mif1", ["mif1"], { after: "heic", size: 22 }),
            // Nor is its version, after the major brand, nor anything in a box too short for one.
            ftyp("mif1", ["mif1"], { version: "heic" }),
            bytes([0, 0, 0, 12], "ftypheic"),
        ]
    ) {
        assertEquals(imageFormatOf(start), undefined, String(start.subarray(0, 24)));
    }
});

Deno.test("the box is read where the bytes start, even within a larger buffer", () => {
    const file = ftyp("mif1", ["mif1", "heic"]);
    const within = new Uint8Array(file.length + 8);
    within.set(file, 8);

    assertEquals(imageFormatOf(within.subarray(8)), "heic");
});
