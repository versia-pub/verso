/**
 * Grouping the rows of a query that asks about many accounts at once.
 * @module
 */

/** The `value` of each of `rows`, in sets by their `key`. */
export const setsBy = <T>(
    rows: readonly T[],
    key: (row: T) => string,
    value: (row: T) => string,
): Map<string, Set<string>> => {
    const sets = new Map<string, Set<string>>();

    for (const row of rows) {
        const set = sets.get(key(row)) ?? new Set();
        sets.set(key(row), set.add(value(row)));
    }

    return sets;
};
