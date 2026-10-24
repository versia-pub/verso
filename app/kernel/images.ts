/**
 * The kinds of picture Verso takes, each with its media type and the vips loader that reads it.
 * AVIF and HEIC are both HEIF files, which one loader reads.
 */
export const imageFormats = {
    jpeg: { mediaType: "image/jpeg", loader: "jpegload" },
    png: { mediaType: "image/png", loader: "pngload" },
    webp: { mediaType: "image/webp", loader: "webpload" },
    gif: { mediaType: "image/gif", loader: "gifload" },
    avif: { mediaType: "image/avif", loader: "heifload" },
    heic: { mediaType: "image/heic", loader: "heifload" },
} as const;

export type ImageFormat = keyof typeof imageFormats;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

const startsWith = (bytes: Uint8Array, expected: readonly number[]) =>
    expected.every((byte, i) => bytes[i] === byte);

/**
 * HEIF files' brands, which say what is in them. `mif1` and `msf1` only say a file is HEIF, so
 * its other brands say which kind.
 * @see https://github.com/AOMediaCodec/av1-avif/blob/main/index.bs
 * @see https://www.iana.org/assignments/media-types/image/heic
 */
const avifBrands = new Set(["avif", "avis"]);
const heicBrands = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);

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

/**
 * What kind of picture `bytes` are, from how they start rather than what anyone says they are, or
 * `undefined` if they aren't one Verso takes. An animated AVIF is an AVIF: only its first picture
 * is read.
 */
export const imageFormatOf = (bytes: Uint8Array): ImageFormat | undefined => {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
    if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";

    const brands = brandsOf(bytes);
    for (const brand of brands) {
        if (avifBrands.has(brand)) return "avif";
        if (heicBrands.has(brand)) return "heic";
    }

    return undefined;
};
