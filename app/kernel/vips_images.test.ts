import {
    assert,
    assertAlmostEquals,
    assertEquals,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import { isBlurhashValid } from "blurhash";
import { decode, encode } from "fast-png";
import { thumbHashToAverageRGBA } from "thumbhash";
import { type Fit, type ImageFormat, imageFormats, type ProcessedImage } from "./images.ts";
import { previewPixels, vipsImages } from "./vips_images.ts";

/** A `width`×`height` PNG, all of one colour. */
const png = (width: number, height: number, [r, g, b, a = 255]: number[]) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).map((_, i) => [r, g, b, a][i % 4]),
        channels: 4,
    }));

/**
 * Runs vips commands, unrestricted, on `pictures` saved as files, and reads what they save as
 * `output`. Files in `dir` can pass from one command to the next.
 */
const made = async (
    pictures: Uint8Array[],
    output: string,
    commands: (inputs: string[], output: string, dir: string) => string[][],
) => {
    const dir = await Deno.makeTempDir();
    try {
        const inputs = pictures.map((_, i) => `${dir}/${i}`);
        await Promise.all(pictures.map((bytes, i) => Deno.writeFile(inputs[i], bytes)));
        for (const args of commands(inputs, `${dir}/${output}`, dir)) {
            const run = await new Deno.Command("vips", { args }).output();
            assert(run.success, new TextDecoder().decode(run.stderr));
        }
        return await Deno.readFile(`${dir}/${output.replace(/\[.*/, "")}`);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
};

/** A `width`×`height` image of one colour, saved with `extension`, such as `jpg`. */
const picture = (extension: string, width: number, height: number, colour: number[]) =>
    made([png(width, height, colour)], `out.${extension}`, ([input], output) => [
        ["copy", input, output],
    ]);

/** An animation with a frame of each colour, saved with `extension`. */
const animation = (extension: string, width: number, height: number, colours: number[][]) =>
    made(
        colours.map((colour) => png(width, height, colour)),
        `out.${extension}[page_height=${height}]`,
        (inputs, output) => [["arrayjoin", inputs.join(" "), output, "--across", "1"]],
    );

/** What vipsheader says of `bytes`' field `field`, or `undefined` if it doesn't have it. */
const field = async (bytes: Uint8Array, field: string) => {
    const dir = await Deno.makeTempDir();
    try {
        await Deno.writeFile(`${dir}/in`, bytes);
        const run = await new Deno.Command("vipsheader", { args: ["-f", field, `${dir}/in`] })
            .output();
        return run.success ? new TextDecoder().decode(run.stdout).trim() : undefined;
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
};

/** Whether `bytes` contain `text` anywhere. */
const contains = (bytes: Uint8Array, text: string) =>
    new TextDecoder("latin1").decode(bytes).includes(text);

/** The average colour of a ThumbHash, as 0–255 for each of red, green, blue and alpha. */
const averageOf = (thumbhash: string) => {
    const { r, g, b, a } = thumbHashToAverageRGBA(Uint8Array.fromBase64(thumbhash));
    return [r, g, b, a].map((value) => value * 255);
};

const assertColour = (actual: number[], expected: number[]) =>
    expected.forEach((value, i) => assertAlmostEquals(actual[i], value, 12));

/** Processes `bytes`, to fit in `fit` if given, and fails unless they are stored. */
const processed = async (
    bytes: Uint8Array<ArrayBuffer>,
    options = { maxPixels: 8_294_400 },
    fit?: Fit,
): Promise<ProcessedImage> => {
    const result = await vipsImages(options).process(ReadableStream.from([bytes]), fit);
    assert(result.ok, `refused as ${result.ok || result.reason}`);
    return result.image;
};

/** A 3×2 JPEG, taken by a camera held on its side, so its EXIF says to turn it a quarter right. */
const sidewaysJpeg = Uint8Array.fromBase64(
    "/9j/4QB8RXhpZgAATU0AKgAAAAgAAwESAAMAAAABAAYAAAITAAMAAAABAAEAAIglAAQAAAABAAAAMgAAAAAAAwAAAAEAAAAE" +
        "AgMAAAABAAIAAAACTgAAAAACAAUAAAADAAAAXAAAAAAAAAAwAAAAAQAAADMAAAABAAAAAAAAAAH/2wBDABALDA4MChAO" +
        "DQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8a" +
        "Gi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAMDASIA" +
        "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
        "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZn" +
        "aGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl" +
        "5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3" +
        "AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RV" +
        "VldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU" +
        "1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiqKKKAP/Z",
);

const red = [200, 30, 30];

const formats: [ImageFormat, string, string][] = [
    ["jpeg", "jpg", "image/jpeg"],
    ["png", "png", "image/png"],
    ["webp", "webp", "image/webp"],
    ["gif", "gif", "image/gif"],
    ["avif", "avif", "image/avif"],
    ["heic", "heic", "image/heic"],
];

for (const [format, extension, mediaType] of formats) {
    Deno.test(`a ${format} picture is kept as one, with a WebP preview and hashes`, async () => {
        const image = await processed(await picture(extension, 40, 30, red));

        assertEquals([image.format, image.mediaType], [format, mediaType]);
        assertEquals([image.width, image.height, image.frames], [40, 30, 1]);
        assertEquals(await field(image.bytes, "vips-loader"), imageFormats[format].loaders[0]);
        assertEquals(image.preview.mediaType, "image/webp");
        assertEquals(await field(image.preview.bytes, "vips-loader"), "webpload");
        assertEquals([image.preview.width, image.preview.height], [40, 30]);
        assertColour(averageOf(image.thumbhash), [...red, 255]);
        assertEquals(isBlurhashValid(image.blurhash).result, true);
    });
}

Deno.test("a photo is turned upright, and its metadata is left out", async () => {
    assert(contains(sidewaysJpeg, "Exif\0\0"));

    const image = await processed(sidewaysJpeg);

    assertEquals([image.width, image.height], [2, 3]);
    assertEquals([image.preview.width, image.preview.height], [2, 3]);
    assertEquals(await field(image.bytes, "orientation"), undefined);
    assert(!contains(image.bytes, "Exif\0\0"));
    assert(!contains(image.preview.bytes, "Exif\0\0"));
});

// GIFs can't store EXIF metadata.
for (const extension of ["png", "webp", "avif", "heic"]) {
    Deno.test(`a ${extension} photo's metadata is left out too`, async () => {
        const photo = await made([sidewaysJpeg], `out.${extension}`, ([input], output) => [
            ["copy", input, output],
        ]);
        assertEquals(await field(photo, "exif-data") !== undefined, true);

        const image = await processed(photo);

        assertEquals([image.width, image.height], [2, 3]);
        assertEquals(await field(image.bytes, "exif-data"), undefined);
    });
}

Deno.test("a picture with more pixels than allowed is scaled down to them", async () => {
    const image = await processed(await picture("png", 80, 60, red), { maxPixels: 1200 });
    assertEquals([image.width, image.height], [40, 30]);

    // Odd sizes don't round over the limit.
    const odd = await processed(await picture("png", 101, 37, red), { maxPixels: 1000 });
    assert(odd.width * odd.height <= 1000, `${odd.width}×${odd.height}`);
    assert(odd.width * odd.height > 900, `${odd.width}×${odd.height}`);
    // vips would produce 21×11, rounding the shorter side up.
    const rounded = await processed(await picture("png", 40, 20, red), { maxPixels: 221 });
    assertEquals([rounded.width, rounded.height], [20, 10]);
    // And it is as large as fits, at exactly the limit.
    const largest = await processed(await picture("png", 29, 20, red), { maxPixels: 294 });
    assertEquals([largest.width, largest.height], [21, 14]);
});

Deno.test("a picture given a box is scaled down to fit in it, as it is, and never up", async () => {
    const box = { width: 40, height: 20 };

    const wide = await processed(await picture("png", 120, 30, red), undefined, box);
    const tall = await processed(await picture("png", 30, 60, red), undefined, box);
    const small = await processed(await picture("png", 10, 8, red), undefined, box);
    const frames = await processed(
        await animation("gif", 80, 40, [red, [30, 30, 200]]),
        undefined,
        box,
    );

    assertEquals([wide.width, wide.height], [40, 10]);
    assertEquals([tall.width, tall.height], [10, 20]);
    assertEquals([small.width, small.height], [10, 8]);
    assertEquals([frames.width, frames.height, frames.frames], [40, 20, 2]);
});

Deno.test("a picture given a box larger than allowed has no more pixels than allowed", async () => {
    const box = { width: 400, height: 400 };

    const wide = await processed(await picture("png", 80, 60, red), { maxPixels: 1200 }, box);
    const tall = await processed(await picture("png", 60, 80, red), { maxPixels: 1200 }, box);

    assertEquals([wide.width, wide.height, tall.width, tall.height], [40, 30, 30, 40]);
});

Deno.test("a picture with exactly as many pixels as allowed keeps its size", async () => {
    const image = await processed(await picture("png", 40, 30, red), { maxPixels: 1200 });
    assertEquals([image.width, image.height], [40, 30]);
});

Deno.test("a preview has at most a preview's pixels", async () => {
    const image = await processed(await picture("png", 1000, 1000, red));

    assertEquals([image.width, image.height], [1000, 1000]);
    assertEquals([image.preview.width, image.preview.height], [480, 480]);
    assert(480 * 480 <= previewPixels);

    // One pixel more than a preview may have.
    const long = await processed(await picture("png", 13_553, 17, red));
    assertEquals(13_553 * 17, previewPixels + 1);
    assertEquals([long.width, long.height], [13_553, 17]);
    assert(long.preview.width * long.preview.height <= previewPixels);
});

for (const extension of ["gif", "webp"]) {
    Deno.test(`an animated ${extension} stays animated, with its first frame as the preview`, async () => {
        const frames = [red, [30, 200, 30], [30, 30, 200]];
        const image = await processed(await animation(extension, 40, 30, frames), {
            maxPixels: 300,
        });

        // Each frame is scaled down to the limit.
        assertEquals([image.width, image.height, image.frames], [20, 15, 3]);
        assertEquals(await field(image.bytes, "n-pages"), "3");
        assertEquals(await field(image.preview.bytes, "n-pages"), undefined);
        assertColour(averageOf(image.thumbhash), [...red, 255]);
    });
}

Deno.test("an Ultra HDR photo is kept as a JPEG, without its gain map", async () => {
    const hdr = await made([png(40, 30, red)], "out.jpg", ([input], output, dir) => [
        ["colourspace", input, `${dir}/hdr.v`, "scrgb"],
        ["uhdrsave", `${dir}/hdr.v`, output],
    ]);
    assertEquals(await field(hdr, "vips-loader"), "uhdrload");

    const image = await processed(hdr);

    assertEquals([image.format, image.width, image.height], ["jpeg", 40, 30]);
    assertEquals(await field(image.bytes, "vips-loader"), "jpegload");
    assertEquals(await field(image.bytes, "gainmap-data"), undefined);
});

Deno.test("a CMYK photo is made sRGB", async () => {
    const cmyk = await made([png(40, 30, red)], "out.jpg", ([input], output) => [
        ["colourspace", input, output, "cmyk"],
    ]);
    assertEquals(await field(cmyk, "bands"), "4");

    const image = await processed(cmyk);

    assertEquals(await field(image.bytes, "bands"), "3");
    assertColour(averageOf(image.thumbhash), [...red, 255]);
});

Deno.test("a Display P3 picture is made sRGB, as it looks", async () => {
    const p3 = await made([png(40, 30, red)], "out.png", ([input], output) => [
        ["icc_transform", input, output, "p3"],
    ]);
    assertEquals(decode(p3).data.slice(0, 3), new Uint8Array([184, 50, 41]));

    const image = await processed(p3);

    assertEquals(await field(image.bytes, "icc-profile-data"), undefined);
    assertEquals(decode(image.bytes).data.slice(0, 3), new Uint8Array(red));
});

Deno.test("a grey picture is hashed in colour, and a see-through one keeps its alpha", async () => {
    const grey = await made([png(40, 30, red)], "out.png", ([input], output) => [
        ["colourspace", input, output, "b-w"],
    ]);
    // Grey, and alpha.
    assertEquals(await field(grey, "bands"), "2");
    const greyHash = averageOf((await processed(grey)).thumbhash);
    // ThumbHash preserves colours only roughly.
    assertAlmostEquals(greyHash[0], greyHash[1], 8);
    assertAlmostEquals(greyHash[1], greyHash[2], 8);

    const clear = await processed(await picture("png", 40, 30, [...red, 0]));
    assertEquals(await field(clear.bytes, "bands"), "4");
    assertAlmostEquals(averageOf(clear.thumbhash)[3], 0, 12);
});

Deno.test("what isn't a picture in a format Verso takes is refused as unsupported", async () => {
    const images = vipsImages({ maxPixels: 8_294_400 });
    const refused = async (bytes: Uint8Array<ArrayBuffer>) => {
        const result = await images.process(ReadableStream.from([bytes]));
        return result.ok ? "kept" : result.reason;
    };

    assertEquals(
        await refused(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
        "unsupported",
    );
    assertEquals(await refused(await picture("tif", 4, 4, red)), "unsupported");
    assertEquals(await refused(new Uint8Array()), "unsupported");
});

Deno.test("a picture vips can't read is refused as broken", async () => {
    const result = await vipsImages({ maxPixels: 8_294_400 }).process(
        ReadableStream.from([
            new Uint8Array([
                0xff,
                0xd8,
                0xff,
                0xe0,
                ...new TextEncoder().encode("not really a JPEG"),
            ]),
        ]),
    );

    assertEquals(result, { ok: false, reason: "broken" });
});

Deno.test("a picture cut short is kept as far as it goes, without its metadata", async () => {
    const noise = await made([], "out.jpg", (_, output) => [["gaussnoise", output, "400", "300"]]);
    // The sideways photo's EXIF segment, after its start of image marker.
    const exif = sidewaysJpeg.subarray(2, 4 + new DataView(sidewaysJpeg.buffer).getUint16(4));
    const photo = new Uint8Array([...noise.subarray(0, 2), ...exif, ...noise.subarray(2)]);
    const cut = photo.slice(0, Math.floor(photo.length * 2 / 3));
    assert(contains(cut, "Exif\0\0"));

    const kept = await processed(cut);

    // Turned upright, as its EXIF says.
    assertEquals([kept.width, kept.height], [300, 400]);
    assert(!contains(kept.bytes, "Exif\0\0"));
});

Deno.test("a picture's metadata can't make it out to be smaller than it is", async () => {
    const encoded = encode({
        width: 40,
        height: 30,
        data: new Uint8Array(40 * 30 * 4),
        channels: 4,
        text: { Comment: "x\nwidth: 1\nheight: 1\nupload: 1x1 uchar, 4 bands, srgb, pngload" },
    });
    // vips reads only the comments before the pixels, so move it there, after the 33 bytes of the
    // signature and header. Its checksum covers only itself, so it stays right.
    const at = new TextDecoder().decode(encoded).indexOf("tEXt") - 4;
    const comment = encoded.slice(
        at,
        at + 12 + new DataView(encoded.buffer, encoded.byteOffset).getUint32(at),
    );
    const rest = [...encoded.subarray(0, at), ...encoded.subarray(at + comment.length)];
    const sneaky = new Uint8Array([...rest.slice(0, 33), ...comment, ...rest.slice(33)]);

    const dir = await Deno.makeTempDir();
    try {
        await Deno.writeFile(`${dir}/sneaky.png`, sneaky);
        const all = await new Deno.Command("vipsheader", { args: ["-a", `${dir}/sneaky.png`] })
            .output();
        assertStringIncludes(new TextDecoder().decode(all.stdout), "\nwidth: 1\n");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }

    const result = await vipsImages({ maxPixels: 8_294_400, maxInputPixels: 1000 }).process(
        ReadableStream.from([sneaky]),
    );

    assertEquals(result, { ok: false, reason: "too-large" });
});

Deno.test("a picture with too many pixels to read, in all its frames, is refused", async () => {
    const images = vipsImages({ maxPixels: 8_294_400, maxInputPixels: 1200 });
    const reasonOf = async (bytes: Uint8Array<ArrayBuffer>) => {
        const result = await images.process(ReadableStream.from([bytes]));
        return result.ok ? "kept" : result.reason;
    };

    assertEquals(await reasonOf(await picture("png", 40, 30, red)), "kept");
    assertEquals(await reasonOf(await picture("png", 41, 30, red)), "too-large");
    // Each frame is small enough, but not all three.
    assertEquals(
        await reasonOf(await animation("gif", 21, 20, [red, [30, 200, 30], red])),
        "too-large",
    );

    // Only the first of a HEIC's images is stored, so only it counts.
    const burst = await animation("heic", 21, 20, [red, red, red]);
    assertEquals(await field(burst, "n-pages"), "3");
    assertEquals(await reasonOf(burst), "kept");
});

Deno.test("vips taking too long is an error, not a refusal", async () => {
    const images = vipsImages({ maxPixels: 8_294_400, timeoutMs: 1 });

    await assertRejects(
        async () => await images.process(ReadableStream.from([await picture("png", 40, 30, red)])),
        Error,
        "took over 1 ms",
    );
});

Deno.test("processing and checking leave no files behind", async () => {
    const directory = await Deno.makeTempDir();
    try {
        const images = vipsImages({ maxPixels: 8_294_400, directory });

        assert((await images.process(ReadableStream.from([await picture("png", 40, 30, red)]))).ok);
        await images.process(ReadableStream.from([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])]));
        await images.check();

        assertEquals(await Array.fromAsync(Deno.readDir(directory)), []);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }

    // They are stored where they are told to be.
    await assertRejects(
        async () =>
            await vipsImages({ maxPixels: 8_294_400, directory: `${directory}/gone` }).process(
                ReadableStream.from([await picture("png", 40, 30, red)]),
            ),
        Deno.errors.NotFound,
    );
});

Deno.test("the check passes with vips on the PATH", async () => {
    await vipsImages({ maxPixels: 8_294_400 }).check();
});
