import { type SelectQueryBuilder, sql } from "kysely";

/**
 * Which page of a list to read: what is older than `max_id`, newer than `since_id`, or just newer
 * than `min_id`, using a cursor that sorts by age, such as a UUIDv7 id.
 */
export type PageBounds = {
    readonly max_id?: string;
    readonly since_id?: string;
    readonly min_id?: string;
    readonly limit: number;
};

/**
 * Reads the page of `query`'s rows that `page` asks for, by the column `cursor`, newest first.
 * `since_id` returns the newest rows after it, and `min_id` the oldest, as Mastodon's do.
 */
export const readPage = async <DB, TB extends keyof DB, O>(
    query: SelectQueryBuilder<DB, TB, O>,
    cursor: string,
    page: PageBounds,
): Promise<O[]> => {
    const column = sql.ref(cursor);
    let bounded = query;

    if (page.max_id !== undefined) bounded = bounded.where(column, "<", page.max_id);
    if (page.since_id !== undefined) bounded = bounded.where(column, ">", page.since_id);
    if (page.min_id !== undefined) bounded = bounded.where(column, ">", page.min_id);

    // Just after `min_id` are its oldest rows, which are then returned newest first like any page.
    const oldestFirst = page.min_id !== undefined;
    const rows = await bounded.orderBy(column, oldestFirst ? "asc" : "desc")
        .limit(page.limit)
        .execute();

    return oldestFirst ? rows.toReversed() : rows;
};
