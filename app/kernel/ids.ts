import type { Clock } from "./clock.ts";

/**
 * Returns a new UUIDv7 each time it is called, with the time it is called, or `at`, which must be
 * after 1970 and not after the year 10889, a UUIDv7's last.
 */
export type IdGenerator = (at?: Date) => string;

/** Fills the array with random bytes, like `crypto.getRandomValues`. */
export type RandomSource = (bytes: Uint8Array) => void;

/**
 * Generates UUIDv7 ids (RFC 9562): the first 48 bits are the clock's time in milliseconds, so ids
 * sort by creation time and can be used as pagination cursors. The rest is random. Ids generated in
 * the same millisecond sort in random order.
 */
export const idGenerator = (
    clock: Clock,
    random: RandomSource = (bytes) => crypto.getRandomValues(bytes),
): IdGenerator =>
(at) => {
    const bytes = new Uint8Array(16);
    random(bytes);

    const time = (at ?? clock.now()).getTime();
    for (let i = 0; i < 6; i++) {
        bytes[i] = Math.floor(time / 2 ** (8 * (5 - i))) % 256;
    }

    bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
    bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
        .join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
        hex.slice(20)
    }`;
};

/**
 * The smallest id generated at `time` or after it, so that ids from `time` on are those at least
 * this one.
 */
export const firstIdAt = (time: Date): string =>
    idGenerator({ now: () => time }, (bytes) => bytes.fill(0))();

/**
 * A random source for tests that counts up, so the ids it helps generate are the same on every run.
 */
export const countingRandom = (): RandomSource => {
    let count = 0;

    return (bytes) => {
        count++;
        bytes.fill(0);
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
            bytes.length - 4,
            count,
        );
    };
};
