/**
 * Default pictures for accounts that haven't uploaded their own: a pattern and colour of their own,
 * drawn from their id, so accounts are told apart at a glance.
 * @module
 */
import { encode } from "fast-png";

/** An sRGB colour, each channel from 0 to 255. */
type Rgb = [number, number, number];

/** A PNG of one colour per pixel, from `palette` by the index `pixel` gives. */
const paletted = (
    width: number,
    height: number,
    palette: Rgb[],
    pixel: (x: number, y: number) => number,
) => {
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
    }

    return encode({ width, height, data, depth: 8, channels: 1, palette });
};

/** A grid of 5 by 5 cells, 70 pixels each, inside a 35-pixel margin. */
const cells = 5;
const cellSize = 70;
const margin = 35;
const avatarSize = cells * cellSize + 2 * margin;

/** Twitter's header size, which most clients crop from. */
const banner = { width: 1500, height: 500 };

const background: Rgb = [240, 240, 240];

/** An HSL colour, with saturation and lightness from 0 to 1, as sRGB. */
const hsl = (hue: number, saturation: number, lightness: number): Rgb => {
    const chroma = saturation * Math.min(lightness, 1 - lightness);
    const channel = (n: number) => {
        const k = (n + hue / 30) % 12;
        return Math.round(255 * (lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };

    return [channel(0), channel(8), channel(4)];
};

/** What a seed looks like: its hue, and which cells of the left three columns are filled. */
const looks = async (seed: string) => {
    const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    );

    return {
        hue: ((hash[0] << 8) | hash[1]) % 360,
        filled: (column: number, row: number) => (hash[2 + row * 3 + column] & 1) === 1,
    };
};

/**
 * A 420×420 PNG of a pattern, mirrored left to right like GitHub's identicons, in a colour. The
 * same seed always gives the same picture.
 */
export const identicon = async (seed: string): Promise<Uint8Array> => {
    const { hue, filled } = await looks(seed);

    return paletted(avatarSize, avatarSize, [background, hsl(hue, 0.6, 0.5)], (x, y) => {
        const column = Math.floor((x - margin) / cellSize);
        const row = Math.floor((y - margin) / cellSize);
        if (x < margin || y < margin || column >= cells || row >= cells) return 0;

        // The right two columns mirror the left two.
        return filled(Math.min(column, cells - 1 - column), row) ? 1 : 0;
    });
};

/** A 1500×500 PNG in a pale shade of the seed's identicon colour. */
export const identiconBanner = async (seed: string): Promise<Uint8Array> => {
    const { hue } = await looks(seed);

    return paletted(banner.width, banner.height, [hsl(hue, 0.5, 0.85)], () => 0);
};
