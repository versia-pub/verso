import type { Selectable } from "kysely";
import { setsBy } from "../db/grouping.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { BookmarksTable } from "./tables.ts";

export type BookmarkRow = Selectable<BookmarksTable>;

/** Bookmarks a status for an account, unless it already is. */
export const insertBookmark = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<void> => {
    await ctx.db.insertInto("bookmarks")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "note_id"]).doNothing())
        .execute();
};

/** Removes an account's bookmark of a status. Returns whether there was one. */
export const deleteBookmark = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<boolean> =>
    (await ctx.db.deleteFrom("bookmarks")
        .where("account_id", "=", accountId)
        .where("note_id", "=", noteId)
        .returning("id")
        .executeTakeFirst()) !== undefined;

/** Which of `noteIds` each of `accountIds` has bookmarked, by account. */
export const bookmarkedAmong = async (
    ctx: Context,
    accountIds: readonly string[],
    noteIds: readonly string[],
): Promise<Map<string, Set<string>>> => {
    if (accountIds.length === 0 || noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("bookmarks").select(["account_id", "note_id"])
        .where("account_id", "in", accountIds)
        .where("note_id", "in", noteIds)
        .execute();

    return setsBy(rows, (row) => row.account_id, (row) => row.note_id);
};

/** A page of an account's bookmarks, latest bookmarked first. */
export const bookmarkPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<BookmarkRow[]> =>
    await readPage(
        ctx.db.selectFrom("bookmarks").selectAll().where("account_id", "=", accountId),
        "id",
        page,
    );
