import type { Insertable, Selectable } from "kysely";
import type { Visibility } from "../accounts/tables.ts";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { BlockedIdQuery } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import type { LikeKind, LikesTable } from "./tables.ts";

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

/**
 * A page of the likes, not dislikes, of a note, but those of the accounts `blocked`, or by an
 * account, newest first.
 */
export const likePage = async (
    ctx: Context,
    by:
        | { readonly noteId: string; readonly blocked: BlockedIdQuery | null }
        | { readonly accountId: string },
    page: PageBounds,
): Promise<LikeRow[]> => {
    const likes = ctx.db.selectFrom("likes").selectAll().where("kind", "=", "like");
    let query = "noteId" in by
        ? likes.where("note_id", "=", by.noteId)
        : likes.where("account_id", "=", by.accountId);
    if ("noteId" in by && by.blocked !== null) {
        query = query.where("account_id", "not in", by.blocked);
    }

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

/** A local like, not one from another instance, if there is one with this id. */
export const findLocalLike = async (ctx: Context, id: string): Promise<LikeRow | undefined> =>
    await ctx.db.selectFrom("likes").selectAll()
        .where("id", "=", id)
        .where("instance_id", "is", null)
        .executeTakeFirst();

/** The likes or dislikes of a note, `kind` as they are. */
const ofNote = (ctx: Context, noteId: string, kind: LikeKind) =>
    ctx.db.selectFrom("likes")
        .leftJoin("instances", "instances.id", "likes.instance_id")
        .where("likes.note_id", "=", noteId)
        .where("likes.kind", "=", kind);

/**
 * A note's likes or dislikes, oldest first, from `offset`: their ids here, and for those from other
 * instances, their ids there and the instances' domains.
 */
export const likesOfNote = async (
    ctx: Context,
    noteId: string,
    kind: LikeKind,
    offset: number,
    limit: number,
): Promise<{ id: string; remote_id: string | null; domain: string | null }[]> =>
    await ofNote(ctx, noteId, kind)
        .select(["likes.id", "likes.remote_id", "instances.domain"])
        .orderBy("likes.id")
        .offset(offset)
        .limit(limit)
        .execute();

/** How many likes or dislikes a note has. */
export const countLikesOfNote = async (
    ctx: Context,
    noteId: string,
    kind: LikeKind,
): Promise<number> =>
    readCount(await ofNote(ctx, noteId, kind).select(countAll).executeTakeFirstOrThrow());

/** The notes with one of `visibilities` an account likes or dislikes, `kind` as they are. */
const byAccount = (
    ctx: Context,
    accountId: string,
    kind: LikeKind,
    visibilities: readonly Visibility[],
) => ctx.db.selectFrom("likes")
    .innerJoin("notes", "notes.id", "likes.note_id")
    .where("likes.account_id", "=", accountId)
    .where("likes.kind", "=", kind)
    .where("notes.visibility", "in", visibilities);

/**
 * The ids of the notes with one of `visibilities` an account likes or dislikes, the earliest liked
 * first, from `offset`.
 */
export const notesLikedBy = async (
    ctx: Context,
    accountId: string,
    kind: LikeKind,
    visibilities: readonly Visibility[],
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await byAccount(ctx, accountId, kind, visibilities)
        .select("likes.note_id")
        .orderBy("likes.id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.note_id);

/** How many notes with one of `visibilities` an account likes or dislikes. */
export const countNotesLikedBy = async (
    ctx: Context,
    accountId: string,
    kind: LikeKind,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await byAccount(ctx, accountId, kind, visibilities).select(countAll)
            .executeTakeFirstOrThrow(),
    );

/** How many likes, not dislikes, the accounts `by` make of each of `noteIds` they like. */
export const countLikesBy = async (
    ctx: Context,
    noteIds: readonly string[],
    by: BlockedIdQuery,
): Promise<Map<string, number>> => {
    if (noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("likes")
        .select((eb) => ["note_id", countAll(eb)])
        .where("note_id", "in", noteIds)
        .where("kind", "=", "like")
        .where("account_id", "in", by)
        .groupBy("note_id")
        .execute();
    return new Map(rows.map((row) => [row.note_id, readCount(row)]));
};
