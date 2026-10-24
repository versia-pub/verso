import { encode } from "blurhash";
import { rgbaToThumbHash } from "thumbhash";

/** A small picture's pixels, row by row, four bytes each: red, green, blue and alpha. */
export type Pixels = {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
};

/** How large a picture a ThumbHash is made from, on each side, at most. */
export const hashedSize = 100;

/**
 * The ThumbHash of `pixels`, in base64, as Versia gives it. They must be at most `hashedSize` on
 * each side.
 * @see https://evanw.github.io/thumbhash/
 */
export const thumbhashOf = (pixels: Pixels): string =>
    rgbaToThumbHash(pixels.width, pixels.height, pixels.rgba).toBase64();

/**
 * The BlurHash of `pixels`, as Mastodon gives it, with four components each way as Mastodon and
 * the old server make it.
 * @see https://blurha.sh/
 */
export const blurhashOf = (pixels: Pixels): string =>
    encode(new Uint8ClampedArray(pixels.rgba), pixels.width, pixels.height, 4, 4);
