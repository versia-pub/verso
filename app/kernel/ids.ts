import type { Clock } from "./clock.ts";

/**
 * Returns a new id each time it is called, with the time it is called, or `at`, which must be from
 * 1970 until before the year 2109, where an id's time runs out. Throws a `RangeError` otherwise.
 */
export type IdGenerator = (at?: Date) => string;

/** Fills the array with random bytes, like `crypto.getRandomValues`. */
export type RandomSource = (bytes: Uint8Array) => void;

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const length = 18;
const timeLimit = 2 ** 42;

const encode = (value: bigint): string => {
    let id = "";

    for (let i = 0; i < length; i++) {
        id = alphabet[Number(value & 31n)] + id;
        value >>= 5n;
    }

    return id;
};

/**
 * Generates ids of 18 characters, the longest a Versia id may be, written in lowercase Crockford
 * base32. An id is a 90-bit number, from the high bits down:
 *
 * | Bits | Holds                                            |
 * | ---- | ------------------------------------------------ |
 * | 42   | The clock's time in milliseconds since 1970      |
 * | 24   | A node id, random and picked once per generator  |
 * | 24   | A counter, which starts random and adds 1 per id |
 *
 * Ids of the same length sort like their numbers, so they sort by creation time and can be used as
 * pagination cursors. Ids from one generator never collide, unless its counter wraps within one
 * millisecond. Ids from different processes collide only if they are made in the same millisecond
 * and have the same node id and counter, which is 1 in 2^48 for each pair.
 */
export const idGenerator = (
    clock: Clock,
    random: RandomSource = (bytes) => crypto.getRandomValues(bytes),
): IdGenerator => {
    const bytes = new Uint8Array(6);
    random(bytes);

    const node = BigInt((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]);
    let counter = BigInt((bytes[3] << 16) | (bytes[4] << 8) | bytes[5]);

    return (at) => {
        const time = (at ?? clock.now()).getTime();
        // A `Date`'s time is a whole number or NaN, which fails both comparisons.
        if (!(time >= 0 && time < timeLimit)) {
            throw new RangeError(`An id's time must be from 1970 to 2109, but it is ${time}`);
        }

        const id = encode((BigInt(time) << 48n) | (node << 24n) | counter);
        counter = (counter + 1n) & 0xffffffn;

        return id;
    };
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
