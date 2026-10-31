/**
 * Matching statuses with users' filters, as Mastodon does: by keyword, in a status's content
 * warning, text and media descriptions, and by id. Statuses are only marked with the filters they
 * match, in their `filtered`, and apps decide where to warn of them or hide them, as their
 * `context` and `filter_action` say.
 * @see https://docs.joinmastodon.org/api/guidelines/#filters
 * @module
 */
import type { Filter, FilterResult, Status } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import {
    activeFiltersOf,
    filterStatusesOf,
    type KeywordRow,
    keywordsOf,
} from "./filter_queries.ts";

/** A filter that applies, ready to match statuses with. */
export type ActiveFilter = {
    /** As statuses render it, without its keywords and statuses. */
    readonly filter: Filter;
    /** Any of its keywords, or `null` if it has none. */
    readonly keywords: RegExp | null;
    /** The ids of its statuses, or `null` if it has none. */
    readonly statusIds: ReadonlySet<string> | null;
};

/** A letter, mark, digit or underscore, which is part of a word in any script. */
const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

/**
 * The pattern of a keyword. A whole word may not have letters right before or after it, where it
 * starts or ends with one, as on Mastodon.
 */
const patternOf = (keyword: KeywordRow) => {
    const escaped = keyword.keyword.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    if (!keyword.whole_word) return escaped;

    const characters = Array.from(keyword.keyword);
    const word = "[\\p{L}\\p{M}\\p{N}_]";
    const before = wordCharacter.test(characters[0] ?? "") ? `(?<!${word})` : "";
    const after = wordCharacter.test(characters.at(-1) ?? "") ? `(?!${word})` : "";
    return before + escaped + after;
};

/** The filters of each of `accountIds` that haven't expired, by account. */
export const activeFiltersAmong = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<Map<string, ActiveFilter[]>> => {
    const rows = await activeFiltersOf(ctx, accountIds);
    const ids = rows.map((row) => row.id);
    const keywords = Object.groupBy(await keywordsOf(ctx, ids), (row) => row.filter_id);
    const statuses = Object.groupBy(await filterStatusesOf(ctx, ids), (row) => row.filter_id);

    const filters = rows.map((row) => {
        const patterns = (keywords[row.id] ?? []).map(patternOf);
        const statusIds = (statuses[row.id] ?? []).map((status) => status.note_id);

        return {
            accountId: row.account_id,
            filter: {
                id: row.id,
                title: row.title,
                context: row.context,
                expires_at: row.expires_at?.toISOString() ?? null,
                filter_action: row.action,
            },
            keywords: patterns.length === 0 ? null : new RegExp(patterns.join("|"), "iu"),
            statusIds: statusIds.length === 0 ? null : new Set(statusIds),
        };
    });

    return Map.groupBy(filters, (filter) => filter.accountId);
};

/** The text keywords are matched in, as Mastodon has it: the content warning, text and media. */
const searchableText = (status: Status) =>
    [
        status.spoiler_text,
        textOfHtml(status.content),
        ...status.media_attachments.flatMap((media) => media.description ?? []),
    ].join("\n\n");

/**
 * The filters of `filters` that `status` matches, as Mastodon gives them: the first keyword found,
 * and of the filter's statuses, the status or the one it boosts. Boosts are matched by the text of
 * the status they boost.
 */
export const filterResults = (
    filters: readonly ActiveFilter[],
    status: Status,
): FilterResult[] => {
    if (filters.length === 0) return [];

    const text = searchableText(status.reblog ?? status);
    const ids = [status.id, ...status.reblog ? [status.reblog.id] : []];

    return filters.flatMap((each): FilterResult[] => {
        const keyword = each.keywords?.exec(text)?.[0];
        const statusMatches = each.statusIds && ids.filter((id) => each.statusIds?.has(id));
        if (keyword === undefined && !statusMatches?.length) return [];

        return [{
            filter: each.filter,
            keyword_matches: keyword === undefined ? null : [keyword],
            status_matches: statusMatches,
        }];
    });
};
