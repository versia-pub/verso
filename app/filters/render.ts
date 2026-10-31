import type { Filter, FilterKeyword, FilterStatus } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import {
    type FilterRow,
    filterStatusesOf,
    type FilterStatusRow,
    type KeywordRow,
    keywordsOf,
} from "./filter_queries.ts";

/** A keyword as Mastodon renders it. */
export const renderKeyword = (row: KeywordRow): FilterKeyword => ({
    id: row.id,
    keyword: row.keyword,
    whole_word: row.whole_word,
});

/** A filter's status as Mastodon renders it. */
export const renderFilterStatus = (row: FilterStatusRow): FilterStatus => ({
    id: row.id,
    status_id: row.note_id,
});

/** Filters as Mastodon renders them, with their keywords and statuses. */
export const renderFilters = async (
    ctx: Context,
    rows: readonly FilterRow[],
): Promise<Filter[]> => {
    const ids = rows.map((row) => row.id);
    const keywords = Object.groupBy(await keywordsOf(ctx, ids), (keyword) => keyword.filter_id);
    const statuses = Object.groupBy(await filterStatusesOf(ctx, ids), (status) => status.filter_id);

    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        context: row.context,
        expires_at: row.expires_at?.toISOString() ?? null,
        filter_action: row.action,
        keywords: (keywords[row.id] ?? []).map(renderKeyword),
        statuses: (statuses[row.id] ?? []).map(renderFilterStatus),
    }));
};

/** A filter as Mastodon renders it, with its keywords and statuses. */
export const renderFilter = async (ctx: Context, row: FilterRow): Promise<Filter> =>
    (await renderFilters(ctx, [row]))[0];
