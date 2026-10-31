import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { FilterKeywordsTable, FiltersTable, FilterStatusesTable } from "./tables.ts";

export type FilterRow = Selectable<FiltersTable>;

export type KeywordRow = Selectable<FilterKeywordsTable>;

export type FilterStatusRow = Selectable<FilterStatusesTable>;

/** What a filter's owner may change. Omitted fields stay as they are. */
export type FilterChanges = Partial<Pick<FilterRow, "title" | "context" | "action" | "expires_at">>;

/** A keyword's properties. */
export type KeywordInput = Pick<KeywordRow, "keyword" | "whole_word">;

/** Adds a filter for `accountId`, and returns it. */
export const insertFilter = async (
    ctx: Context,
    accountId: string,
    filter: Required<FilterChanges>,
): Promise<FilterRow> =>
    await ctx.db.insertInto("filters")
        .values({ id: ctx.ids(), account_id: accountId, ...filter, created_at: ctx.clock.now() })
        .returningAll()
        .executeTakeFirstOrThrow();

/** Changes the filter `filterId`, and returns it. */
export const updateFilter = async (
    ctx: Context,
    filterId: string,
    changes: FilterChanges,
): Promise<FilterRow> => {
    // Kysely omits the columns set to `undefined`, and an update must set something.
    if (Object.values(changes).every((value) => value === undefined)) {
        return await ctx.db.selectFrom("filters").selectAll()
            .where("id", "=", filterId)
            .executeTakeFirstOrThrow();
    }

    return await ctx.db.updateTable("filters")
        .set(changes)
        .where("id", "=", filterId)
        .returningAll()
        .executeTakeFirstOrThrow();
};

/** Removes `accountId`'s filter `filterId`. Returns whether they had it. */
export const deleteFilter = async (
    ctx: Context,
    accountId: string,
    filterId: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("filters")
        .where("id", "=", filterId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/** `accountId`'s filter `filterId`, if they have it. */
export const findFilter = async (
    ctx: Context,
    accountId: string,
    filterId: string,
): Promise<FilterRow | undefined> =>
    await ctx.db.selectFrom("filters").selectAll()
        .where("id", "=", filterId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** `accountId`'s filters, oldest first, expired ones too. */
export const filtersOf = async (ctx: Context, accountId: string): Promise<FilterRow[]> =>
    await ctx.db.selectFrom("filters").selectAll()
        .where("account_id", "=", accountId)
        .orderBy("id")
        .execute();

/** The keywords of the filters `filterIds`, oldest first. */
export const keywordsOf = async (
    ctx: Context,
    filterIds: readonly string[],
): Promise<KeywordRow[]> =>
    filterIds.length === 0 ? [] : await ctx.db.selectFrom("filter_keywords").selectAll()
        .where("filter_id", "in", filterIds)
        .orderBy("id")
        .execute();

/** The statuses the filters `filterIds` match, the oldest added first. */
export const filterStatusesOf = async (
    ctx: Context,
    filterIds: readonly string[],
): Promise<FilterStatusRow[]> =>
    filterIds.length === 0 ? [] : await ctx.db.selectFrom("filter_statuses").selectAll()
        .where("filter_id", "in", filterIds)
        .orderBy("id")
        .execute();

/** Adds a keyword to the filter `filterId`, and returns it. */
export const insertKeyword = async (
    ctx: Context,
    filterId: string,
    keyword: KeywordInput,
): Promise<KeywordRow> =>
    await ctx.db.insertInto("filter_keywords")
        .values({ id: ctx.ids(), filter_id: filterId, ...keyword, created_at: ctx.clock.now() })
        .returningAll()
        .executeTakeFirstOrThrow();

/** Changes the keyword `keywordId`, and returns it. */
export const updateKeyword = async (
    ctx: Context,
    keywordId: string,
    changes: Partial<KeywordInput>,
): Promise<KeywordRow> => {
    if (Object.values(changes).every((value) => value === undefined)) {
        return await ctx.db.selectFrom("filter_keywords").selectAll()
            .where("id", "=", keywordId)
            .executeTakeFirstOrThrow();
    }

    return await ctx.db.updateTable("filter_keywords")
        .set(changes)
        .where("id", "=", keywordId)
        .returningAll()
        .executeTakeFirstOrThrow();
};

/** Removes the keywords `keywordIds`. */
export const deleteKeywords = async (
    ctx: Context,
    keywordIds: readonly string[],
): Promise<void> => {
    if (keywordIds.length === 0) return;

    await ctx.db.deleteFrom("filter_keywords").where("id", "in", keywordIds).execute();
};

/** The keyword `keywordId`, if it is in one of `accountId`'s filters. */
export const findKeyword = async (
    ctx: Context,
    accountId: string,
    keywordId: string,
): Promise<KeywordRow | undefined> =>
    await ctx.db.selectFrom("filter_keywords").selectAll("filter_keywords")
        .innerJoin("filters", "filters.id", "filter_keywords.filter_id")
        .where("filter_keywords.id", "=", keywordId)
        .where("filters.account_id", "=", accountId)
        .executeTakeFirst();

/** Adds the status `noteId` to the filter `filterId`, and returns it. */
export const insertFilterStatus = async (
    ctx: Context,
    filterId: string,
    noteId: string,
): Promise<FilterStatusRow> =>
    await ctx.db.insertInto("filter_statuses")
        .values({
            id: ctx.ids(),
            filter_id: filterId,
            note_id: noteId,
            created_at: ctx.clock.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

/** Whether the filter `filterId` matches the status `noteId` already. */
export const hasFilterStatus = async (
    ctx: Context,
    filterId: string,
    noteId: string,
): Promise<boolean> =>
    await ctx.db.selectFrom("filter_statuses").select("id")
        .where("filter_id", "=", filterId)
        .where("note_id", "=", noteId)
        .executeTakeFirst() !== undefined;

/** The filter status `id`, if it is in one of `accountId`'s filters. */
export const findFilterStatus = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<FilterStatusRow | undefined> =>
    await ctx.db.selectFrom("filter_statuses").selectAll("filter_statuses")
        .innerJoin("filters", "filters.id", "filter_statuses.filter_id")
        .where("filter_statuses.id", "=", id)
        .where("filters.account_id", "=", accountId)
        .executeTakeFirst();

/** Removes the filter status `id`. */
export const deleteFilterStatus = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("filter_statuses").where("id", "=", id).execute();
};
