import { decode } from "fast-png";
import { blurhashOf, hashedSize, type Pixels, thumbhashOf } from "./image_hashes.ts";
import {
    formatHeadLength,
    type ImageFormat,
    imageFormatOf,
    imageFormats,
    type ImageProcessor,
    type ImageRefusal,
} from "./images.ts";

export type VipsOptions = {
    /** How many pixels a kept picture may have in each frame. Larger ones are scaled down. */
    readonly maxPixels: number;
    /**
     * How many pixels an upload may have in all its frames, to be read at all. Reading one takes
     * memory in proportion, so a small file can't make vips take it all. Defaults to 100 million.
     */
    readonly maxInputPixels?: number;
    /** How long each vips command may take, in milliseconds. Defaults to a minute. */
    readonly timeoutMs?: number;
    /** Where files are kept while they are processed. Defaults to the temporary directory. */
    readonly directory?: string;
};

/** How many pixels a preview has at most, as Mastodon's do: 640×360. */
export const previewPixels = 230_400;

/** How each format is saved: its extension, which picks the saver, and the saver's options. */
const savers: Record<ImageFormat, { extension: string; options: string }> = {
    jpeg: { extension: "jpg", options: "keep=none,Q=90" },
    png: { extension: "png", options: "keep=none" },
    webp: { extension: "webp", options: "keep=none,Q=90" },
    // vips saves no metadata in GIFs.
    gif: { extension: "gif", options: "" },
    avif: { extension: "avif", options: "keep=none" },
    heic: { extension: "heic", options: "keep=none" },
};

/** The formats whose every frame is read, so animations stay animated. */
const animated: ReadonlySet<ImageFormat> = new Set(["gif", "webp"]);

/** What `check` makes sure vips won't read, as it would with its untrusted loaders allowed. */
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

/**
 * The longest side a `width`×`height` picture can be scaled to so that it has at most `pixels`. It
 * may be longer than the picture's: vips is told not to make pictures larger.
 */
const longestSide = (width: number, height: number, pixels: number) => {
    const longest = Math.max(width, height);
    const shortest = Math.min(width, height);
    let side = Math.ceil(longest * Math.sqrt(pixels / (width * height)));
    // vips rounds the shorter side to the nearest pixel, which can take it over.
    while (side * Math.round(shortest * side / longest) > pixels) side -= 1;

    return side;
};

/**
 * What vipsheader's one-line summaries say of each picture: its size, of one frame, and the loader
 * that read it. Other fields can come from the file, so it could make up lines that look like
 * them.
 */
const summariesOf = (stdout: Uint8Array) =>
    new TextDecoder().decode(stdout).split("\n").flatMap((line) => {
        // Such as "/tmp/…/upload: 40x30 uchar, 3 bands, srgb, jpegload".
        const summary = /: (\d+)x(\d+) .*, (\w+)$/.exec(line);
        return summary
            ? [{ width: Number(summary[1]), height: Number(summary[2]), loader: summary[3] }]
            : [];
    });

/** The first bytes of the file at `path`, or all of them if it is shorter. */
const headOf = async (path: string) => {
    using file = await Deno.open(path);
    const head = new Uint8Array(formatHeadLength);
    let read = 0;
    while (read < formatHeadLength) {
        const n = await file.read(head.subarray(read));
        if (n === null) break;
        read += n;
    }

    return head.subarray(0, read);
};

/** A PNG's pixels as RGBA. vips makes it 8-bit sRGB, so it has three channels, or four with alpha. */
const pixelsOf = (png: Uint8Array): Pixels => {
    const { width, height, data, channels } = decode(png);
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let i = 0; i < width * height; i++) {
        rgba.set(data.subarray(i * channels, (i + 1) * channels), i * 4);
    }

    return { width, height, rgba };
};

/**
 * Processes pictures with the vips command-line tools, which must be on the PATH. Uploads are
 * checked to be what they start like, and vips reads them only with the loaders for that format,
 * never with its untrusted loaders, such as ImageMagick's.
 * @see https://www.libvips.org/API/current/using-from-cli.html
 */
export const vipsImages = (options: VipsOptions): ImageProcessor => {
    const { maxPixels, maxInputPixels = 100_000_000, timeoutMs = 60_000, directory } = options;

    /** Runs `program`, with vips's untrusted loaders blocked, or throws if it takes too long. */
    const run = async (program: string, args: string[]) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const output = await new Deno.Command(program, {
            args,
            env: { VIPS_BLOCK_UNTRUSTED: "1" },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
            signal,
        }).output();

        if (signal.aborted) throw new Error(`${program} took over ${timeoutMs} ms`);
        return output;
    };

    /** Runs `work` with a directory of its own, removed afterwards. */
    const withDirectory = async <T>(work: (dir: string) => Promise<T>) => {
        const dir = await Deno.makeTempDir({ dir: directory, prefix: "verso-image-" });
        try {
            return await work(dir);
        } finally {
            await Deno.remove(dir, { recursive: true });
        }
    };

    /**
     * Saves `input` as `output`, upright, in sRGB and scaled to fit a `side`-pixel square. What
     * there is of a picture cut short is saved, with grey for the rest, so that its metadata can
     * still be left out: vips can't leave it out without reading the picture.
     */
    const thumbnail = (input: string, output: string, side: number) =>
        run("vips", [
            "thumbnail",
            input,
            output,
            `${side}`,
            "--height",
            `${side}`,
            "--size",
            "down",
            "--export-profile",
            "srgb",
        ]);

    /** The size of a picture Verso made, which vips must be able to read. */
    const sizeOf = async (path: string) => {
        const output = await run("vipsheader", [path]);
        const [summary] = summariesOf(output.stdout);
        if (summary === undefined) {
            throw new Error(`vips can't read ${path}: ${new TextDecoder().decode(output.stderr)}`);
        }

        return summary;
    };

    /** How many frames the animation at `path` has. vips leaves out the field for just one. */
    const framesOf = async (path: string) => {
        const output = await run("vipsheader", ["-f", "n-pages", path]);
        return output.success ? Number(new TextDecoder().decode(output.stdout)) : 1;
    };

    const refuse = (reason: ImageRefusal) => ({ ok: false, reason }) as const;

    /** Processes the picture at `input`, of `format`, with its files in `dir`. */
    const processIn = async (dir: string, input: string, format: ImageFormat) => {
        const [summary] = summariesOf((await run("vipsheader", [input])).stdout);
        if (summary === undefined) return refuse("broken");

        const loaders: readonly string[] = imageFormats[format].loaders;
        if (!loaders.includes(summary.loader)) return refuse("unsupported");

        // Without the n option, vips reads an animation's first frame, so this is one frame's.
        const { width, height } = summary;
        const frames = animated.has(format) ? await framesOf(input) : 1;
        if (width * height * frames > maxInputPixels) return refuse("too-large");

        const { extension, options } = savers[format];
        const original = `${dir}/original.${extension}`;
        const kept = await thumbnail(
            animated.has(format) ? `${input}[n=-1]` : input,
            `${original}[${options}]`,
            longestSide(width, height, maxPixels),
        );
        if (!kept.success) return refuse("broken");

        // The rest are made from what is kept, which is upright, sRGB and small enough, so the
        // upload is read only once.
        const size = await sizeOf(original);
        const preview = `${dir}/preview.webp`;
        const hashed = `${dir}/hashed.png`;
        await Promise.all([
            thumbnail(
                original,
                `${preview}[keep=none]`,
                longestSide(size.width, size.height, previewPixels),
            ),
            thumbnail(original, hashed, hashedSize),
        ]);

        const previewSize = await sizeOf(preview);
        const pixels = pixelsOf(await Deno.readFile(hashed));

        return {
            ok: true,
            image: {
                format,
                bytes: await Deno.readFile(original),
                mediaType: imageFormats[format].mediaType,
                width: size.width,
                height: size.height,
                frames,
                preview: {
                    bytes: await Deno.readFile(preview),
                    mediaType: "image/webp",
                    width: previewSize.width,
                    height: previewSize.height,
                },
                thumbhash: thumbhashOf(pixels),
                blurhash: blurhashOf(pixels),
            },
        } as const;
    };

    return {
        process: (stream) =>
            withDirectory(async (dir) => {
                const input = `${dir}/upload`;
                await Deno.writeFile(input, stream);

                const format = imageFormatOf(await headOf(input));
                if (format === undefined) return refuse("unsupported");

                return await processIn(dir, input, format);
            }),
        // Running vips throws if it isn't there.
        check: () =>
            withDirectory(async (dir) => {
                await Deno.writeTextFile(`${dir}/check.svg`, svg);
                if ((await run("vipsheader", [`${dir}/check.svg`])).success) {
                    throw new Error(
                        "vips reads untrusted formats such as SVG. Verso needs vips 8.13 or later, " +
                            "which can be told not to",
                    );
                }
            }),
    };
};
