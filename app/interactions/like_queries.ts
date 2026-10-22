import type { Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { LikesTable } from "./tables.ts";

export type LikeRow = Selectable<LikesTable>;

/** Adds a like, unless the account already likes the note. Returns it if it was added. */
export const insertLike = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<LikeRow | undefined> =>
    await ctx.db.insertInto("likes")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "note_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();

/** Removes an account's like of a note, and returns it, if there was one. */
export const deleteLike = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<LikeRow | undefined> =>
    await ctx.db.deleteFrom("likes")
        .where("account_id", "=", accountId)
        .where("note_id", "=", noteId)
        .returningAll()
        .executeTakeFirst();

/** The account's like of a note, if it likes it. */
export const findLike = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<LikeRow | undefined> =>
    await ctx.db.selectFrom("likes").selectAll()
        .where("account_id", "=", accountId)
        .where("note_id", "=", noteId)
        .executeTakeFirst();

/** Which of `noteIds` the account likes. */
export const likedAmong = async (
    ctx: Context,
    accountId: string,
    noteIds: readonly string[],
): Promise<Set<string>> => {
    if (noteIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("likes").select("note_id")
        .where("account_id", "=", accountId)
        .where("note_id", "in", noteIds)
        .execute();
    return new Set(rows.map((row) => row.note_id));
};

/** A page of the likes of a note, or by an account, newest first. */
export const likePage = async (
    ctx: Context,
    by: { readonly noteId: string } | { readonly accountId: string },
    page: PageBounds,
): Promise<LikeRow[]> => {
    const query = "noteId" in by
        ? ctx.db.selectFrom("likes").selectAll().where("note_id", "=", by.noteId)
        : ctx.db.selectFrom("likes").selectAll().where("account_id", "=", by.accountId);

    return await readPage(query, "id", page);
};

/** Counts a like of a note, or one undone. */
export const countLike = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/** Uncounts the likes of an account from the notes it likes. */
export const uncountLikesBy = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "-", 1) }))
        .where(
            "id",
            "in",
            (eb) =>
                eb.selectFrom("likes").select("likes.note_id").where(
                    "likes.account_id",
                    "=",
                    accountId,
                ),
        )
        .execute();
};
