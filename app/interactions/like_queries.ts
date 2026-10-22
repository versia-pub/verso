import type { Insertable, Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { LikesTable } from "./tables.ts";

export type LikeRow = Selectable<LikesTable>;

/**
 * Adds a local like, unless the account already likes or dislikes the note. Returns it if it was
 * added.
 */
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

/** Removes an account's like or dislike of a note, and returns it, if there was one. */
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

/** Adds another instance's like or dislike. */
export const insertRemoteLike = async (
    ctx: Context,
    like: Insertable<LikesTable>,
): Promise<void> => {
    await ctx.db.insertInto("likes").values(like).execute();
};

/** The like or dislike with the id `remoteId` on the instance `instanceId`, if Verso has it. */
export const findRemoteLike = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<LikeRow | undefined> =>
    await ctx.db.selectFrom("likes").selectAll()
        .where("instance_id", "=", instanceId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/** Removes a like or dislike, and returns it, if there was one. */
export const deleteLikeById = async (ctx: Context, id: string): Promise<LikeRow | undefined> =>
    await ctx.db.deleteFrom("likes").where("id", "=", id).returningAll().executeTakeFirst();

/** The account's like or dislike of a note, if it has one. */
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
        .where("kind", "=", "like")
        .execute();
    return new Set(rows.map((row) => row.note_id));
};

/** A page of the likes, not dislikes, of a note, or by an account, newest first. */
export const likePage = async (
    ctx: Context,
    by: { readonly noteId: string } | { readonly accountId: string },
    page: PageBounds,
): Promise<LikeRow[]> => {
    const likes = ctx.db.selectFrom("likes").selectAll().where("kind", "=", "like");
    const query = "noteId" in by
        ? likes.where("note_id", "=", by.noteId)
        : likes.where("account_id", "=", by.accountId);

    return await readPage(query, "id", page);
};

/** Counts a like of a note, or one undone. */
export const countLike = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/** Uncounts the likes, not dislikes, of an account from the notes it likes. */
export const uncountLikesBy = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "-", 1) }))
        .where("id", "in", (eb) =>
            eb.selectFrom("likes").select("likes.note_id")
                .where("likes.account_id", "=", accountId)
                .where("likes.kind", "=", "like"))
        .execute();
};
