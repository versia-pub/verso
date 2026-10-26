/**
 * The kinds of image Verso accepts, each with its media type and the vips loaders that read it.
 * Ultra HDR photos are JPEGs with a gain map, which a loader of their own reads. AVIF and HEIC are
 * both HEIF files, which one loader reads.
 */
export const imageFormats = {
    jpeg: { mediaType: "image/jpeg", loaders: ["jpegload", "uhdrload"] },
    png: { mediaType: "image/png", loaders: ["pngload"] },
    webp: { mediaType: "image/webp", loaders: ["webpload"] },
    gif: { mediaType: "image/gif", loaders: ["gifload"] },
    avif: { mediaType: "image/avif", loaders: ["heifload"] },
    heic: { mediaType: "image/heic", loaders: ["heifload"] },
} as const;

export type ImageFormat = keyof typeof imageFormats;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

const startsWith = (bytes: Uint8Array, expected: readonly number[]) =>
    expected.every((byte, i) => bytes[i] === byte);

/**
 * HEIF files' brands, which say what is in them. `mif1` only says a file is HEIF, so its other
 * brands say which kind. Sequences, such as animated AVIFs, have brands of their own: vips can't
 * read them as animations, so they are stored as files rather than as images.
 * @see https://github.com/AOMediaCodec/av1-avif/blob/main/index.bs
 * @see https://www.iana.org/assignments/media-types/image/heic
 */
const avifBrands = new Set(["avif"]);
const heicBrands = new Set(["heic", "heix", "heim", "heis"]);
const sequenceBrands = new Set(["msf1", "avis", "hevc", "hevx", "hevm", "hevs"]);

/** The brands of an ISO media file, major first, from its `ftyp` box, if it starts with one. */
const brandsOf = (bytes: Uint8Array) => {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return [];

    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    const end = Math.min(size, bytes.length);
    const brands = [ascii(bytes, 8, 12)];
    // After the major brand comes its version, then the compatible brands.
    for (let start = 16; start + 4 <= end; start += 4) brands.push(ascii(bytes, start, start + 4));

    return brands;
};

/** How many of a file's first bytes {@link imageFormatOf} needs. */
export const formatHeadLength = 64;

/**
 * What kind of image `bytes` are, from how they start rather than what anyone says they are, or
 * `undefined` if they aren't one Verso accepts. The first {@link formatHeadLength} are enough.
 */
export const imageFormatOf = (bytes: Uint8Array): ImageFormat | undefined => {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
    if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";

    const brands = brandsOf(bytes);
    if (brands.some((brand) => sequenceBrands.has(brand))) return undefined;
    for (const brand of brands) {
        if (avifBrands.has(brand)) return "avif";
        if (heicBrands.has(brand)) return "heic";
    }

    return undefined;
};

/** An image as Verso stores it. */
export type Picture = {
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly mediaType: string;
    /** Of one frame, for an animation. */
    readonly width: number;
    readonly height: number;
};

/** An uploaded image, made ready to store and display. */
export type ProcessedImage = Picture & {
    readonly format: ImageFormat;
    /** How many frames it has: more than one for an animated GIF or WebP. */
    readonly frames: number;
    /** A small WebP of its first frame, for timelines. */
    readonly preview: Picture;
    readonly thumbhash: string;
    readonly blurhash: string;
};

/**
 * Why an upload isn't an image Verso can display. One that is an image by its bytes can't be
 * stored, as it may hold metadata.
 */
export type ImageRefusal = "unsupported" | "broken" | "too-large";

/** A box an image is scaled down to fit in, keeping its aspect ratio, such as for an avatar. */
export type Fit = { readonly width: number; readonly height: number };

/** Turns uploads into images fit to store and display. */
export type ImageProcessor = {
    /**
     * `input`'s image upright, without metadata, in sRGB and scaled down if too large, or to fit
     * in `fit` if given, with a preview and placeholder hashes. Rejects what isn't an image in a
     * format Verso accepts, what can't be read at all, and what has too many pixels to read
     * safely. Throws if it can't try.
     */
    readonly process: (
        input: ReadableStream<Uint8Array>,
        fit?: Fit,
    ) => Promise<{ ok: true; image: ProcessedImage } | { ok: false; reason: ImageRefusal }>;
    /** Throws unless Verso can process images, so it stops when it starts rather than later. */
    readonly check: () => Promise<void>;
};
