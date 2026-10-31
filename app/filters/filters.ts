/**
 * Filters: the keywords and statuses that local users filter out of what they read, each group with
 * the places it applies and what is done with what it matches, as Mastodon's v2 filters. They
 * aren't federated.
 * @see https://docs.joinmastodon.org/methods/filters/
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { visibleNote } from "../notes/visibility.ts";
import {
    deleteFilterStatus,
    deleteKeywords,
    type FilterRow,
    type FilterStatusRow,
    findFilter,
    findFilterStatus,
    findKeyword,
    hasFilterStatus,
    insertFilter,
    insertFilterStatus,
    insertKeyword,
    type KeywordInput,
    type KeywordRow,
    keywordsOf,
    updateFilter,
    updateKeyword,
} from "./filter_queries.ts";

/** A filter's properties, with when it expires as seconds from now, or `null` for never. */
export type NewFilter = Pick<FilterRow, "title" | "context" | "action"> & {
    readonly expiresIn: number | null;
};

/** What a filter's owner may change, as {@link NewFilter}. Omitted fields stay as they are. */
export type FilterInput = Partial<NewFilter>;

/** A change to one of a filter's keywords, as Mastodon's `keywords_attributes` asks for. */
export type KeywordChange =
    | { readonly add: KeywordInput }
    | { readonly change: string; readonly to: Partial<KeywordInput> }
    | { readonly remove: string };

const expiryOf = (ctx: Context, expiresIn: number | null) =>
    expiresIn === null ? null : new Date(ctx.clock.now().getTime() + expiresIn * 1000);

/** Makes a filter for `accountId`, with `keywords`. */
export const createFilter = (
    ctx: Context,
    accountId: string,
    { expiresIn, ...filter }: NewFilter,
    keywords: readonly KeywordInput[],
): Promise<FilterRow> =>
    ctx.transaction(async (tx) => {
        const row = await insertFilter(tx, accountId, {
            ...filter,
            expires_at: expiryOf(tx, expiresIn),
        });
        for (const keyword of keywords) await insertKeyword(tx, row.id, keyword);

        return row;
    });

const idOf = (change: Exclude<KeywordChange, { add: KeywordInput }>) =>
    "change" in change ? change.change : change.remove;

/**
 * Changes `accountId`'s filter `filterId`, and its keywords as `keywords` ask. Returns `"no_filter"`
 * if they have no such filter, and `"no_keyword"`, changing nothing, if one of `keywords` names a
 * keyword it doesn't have.
 */
export const changeFilter = (
    ctx: Context,
    accountId: string,
    filterId: string,
    { expiresIn, ...changes }: FilterInput,
    keywords: readonly KeywordChange[],
): Promise<FilterRow | "no_filter" | "no_keyword"> =>
    ctx.transaction(async (tx) => {
        if (await findFilter(tx, accountId, filterId) === undefined) return "no_filter";

        const own = new Set((await keywordsOf(tx, [filterId])).map((keyword) => keyword.id));
        const named = keywords.flatMap((each) => "add" in each ? [] : [idOf(each)]);
        if (named.some((id) => !own.has(id))) return "no_keyword";

        const row = await updateFilter(tx, filterId, {
            ...changes,
            ...expiresIn === undefined ? {} : { expires_at: expiryOf(tx, expiresIn) },
        });
        for (const each of keywords) {
            if ("add" in each) await insertKeyword(tx, filterId, each.add);
            else if ("change" in each) await updateKeyword(tx, each.change, each.to);
        }
        await deleteKeywords(tx, keywords.flatMap((each) => "remove" in each ? [each.remove] : []));

        return row;
    });

/** Adds a keyword to `accountId`'s filter `filterId`, if they have it. */
export const addKeyword = (
    ctx: Context,
    accountId: string,
    filterId: string,
    keyword: KeywordInput,
): Promise<KeywordRow | undefined> =>
    ctx.transaction(async (tx) => {
        if (await findFilter(tx, accountId, filterId) === undefined) return;
        return await insertKeyword(tx, filterId, keyword);
    });

/** Changes the keyword `keywordId`, if it is in one of `accountId`'s filters. */
export const changeKeyword = (
    ctx: Context,
    accountId: string,
    keywordId: string,
    changes: Partial<KeywordInput>,
): Promise<KeywordRow | undefined> =>
    ctx.transaction(async (tx) => {
        if (await findKeyword(tx, accountId, keywordId) === undefined) return;
        return await updateKeyword(tx, keywordId, changes);
    });

/** Removes the keyword `keywordId`, if it is in one of `accountId`'s filters. Returns whether. */
export const removeKeyword = (
    ctx: Context,
    accountId: string,
    keywordId: string,
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (await findKeyword(tx, accountId, keywordId) === undefined) return false;

        await deleteKeywords(tx, [keywordId]);
        return true;
    });

/**
 * Adds the status `noteId` to `accountId`'s filter `filterId`. Returns `"no_filter"` if they have no
 * such filter, `"missing"` if they can't see the status, and `"taken"` if the filter has it already.
 */
export const addFilterStatus = (
    ctx: Context,
    accountId: string,
    filterId: string,
    noteId: string,
): Promise<FilterStatusRow | "no_filter" | "missing" | "taken"> =>
    ctx.transaction(async (tx) => {
        if (await findFilter(tx, accountId, filterId) === undefined) return "no_filter";
        if (await visibleNote(tx, noteId, accountId) === undefined) return "missing";
        if (await hasFilterStatus(tx, filterId, noteId)) return "taken";

        return await insertFilterStatus(tx, filterId, noteId);
    });

/** Removes the filter status `id`, if it is in one of `accountId`'s filters. Returns whether. */
export const removeFilterStatus = (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (await findFilterStatus(tx, accountId, id) === undefined) return false;

        await deleteFilterStatus(tx, id);
        return true;
    });
