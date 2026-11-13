import { batchesOf } from "../db/batches.ts";

/** How to make a table of trending rows hold exactly `rows`. */
export type Replacement<Row> = {
    readonly rows: readonly Row[];
    /** The key that identifies a row in its table. */
    readonly keyOf: (row: Row) => string;
    /** The keys of the rows the table holds now. */
    readonly stored: readonly string[];
    /** Deletes the rows with these keys. */
    readonly remove: (keys: string[]) => Promise<unknown>;
    /** Adds these rows, or updates the ones that exist. */
    readonly upsert: (rows: Row[]) => Promise<unknown>;
};

/** Deletes the stored rows that aren't in `rows`, then upserts `rows`, both in batches. */
export const replaceRows = async <Row>(replacement: Replacement<Row>): Promise<void> => {
    const { rows, keyOf, stored, remove, upsert } = replacement;
    const kept = new Set(rows.map(keyOf));

    for (const batch of batchesOf(stored.filter((key) => !kept.has(key)))) await remove(batch);

    for (const batch of batchesOf(rows)) await upsert(batch);
};
