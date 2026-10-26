/**
 * How many rows, or ids, go in one query. Databases limit the values one query may bind, Postgres
 * to 65,535, so long lists are split into batches well under it.
 */
export const batchSize = 1000;

/** `items` in order, in batches of at most `size`. */
export const batchesOf = <T>(items: readonly T[], size: number = batchSize): T[][] => {
    const batches = [];
    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }

    return batches;
};
