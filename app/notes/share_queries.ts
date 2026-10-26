import { uncountStatusesFor } from "../accounts/count_queries.ts";
import type { Visibility } from "../accounts/tables.ts";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, isExcluded, notExcluded } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import type { NoteIdQuery } from "./removal_queries.ts";

/** Counts a share of a note, or one deleted. */
export const countShare = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ shares_count: eb("shares_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/**
 * Uncounts the shares among `notes` from the notes they share. An account shares a note once, and
 * `notes` are one account's.
 */
export const uncountSharesAmong = async (ctx: Context, notes: NoteIdQuery): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ shares_count: eb("shares_count", "-", 1) }))
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as share").select("share.reblog_of_id")
                .where("share.id", "in", notes)
                .where("share.reblog_of_id", "is not", null))
        .execute();
};

/**
 * Uncounts the shares of `noteId` from the statuses of the accounts that made them, as they go with
 * it. Direct ones aren't counted, so they aren't uncounted.
 */
export const uncountSharersOf = (ctx: Context, noteId: string): Promise<void> =>
    uncountStatusesFor(
        ctx,
        ctx.db.selectFrom("notes").select("notes.account_id")
            .where("notes.reblog_of_id", "=", noteId)
            .where("notes.visibility", "!=", "direct"),
    );

/**
 * Uncounts the shares of `notes` from the statuses of the accounts that made them, as they go with
 * the notes when they are deleted.
 */
export const uncountSharersOfAmong = (ctx: Context, notes: NoteIdQuery): Promise<void> =>
    uncountStatusesFor(
        ctx,
        ctx.db.selectFrom("notes").select("notes.account_id")
            .where("notes.reblog_of_id", "in", notes)
            .where("notes.visibility", "!=", "direct"),
    );

/** An account's share of a note, if it shares it. */
export const findShare = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll()
        .where("account_id", "=", accountId)
        .where("reblog_of_id", "=", noteId)
        .executeTakeFirst();

/** Removes an account's share of a note, and returns it, if there was one. */
export const deleteShare = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.deleteFrom("notes")
        .where("account_id", "=", accountId)
        .where("reblog_of_id", "=", noteId)
        .returningAll()
        .executeTakeFirst();

/** Which of `noteIds` the account shares. */
export const sharedAmong = async (
    ctx: Context,
    accountId: string,
    noteIds: readonly string[],
): Promise<Set<string>> => {
    if (noteIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("notes").select("reblog_of_id")
        .where("account_id", "=", accountId)
        .where("reblog_of_id", "in", noteIds)
        .execute();
    return new Set(rows.flatMap((row) => row.reblog_of_id ?? []));
};

/** The shares of `noteId` with one of `visibilities`. */
const sharesOf = (ctx: Context, noteId: string, visibilities: readonly Visibility[]) =>
    ctx.db.selectFrom("notes")
        .where("reblog_of_id", "=", noteId)
        .where("visibility", "in", visibilities);

/** The ids of the shares of `noteId`, as {@link sharesOf} finds them, oldest first. */
export const shareIdsOf = async (
    ctx: Context,
    noteId: string,
    visibilities: readonly Visibility[],
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await sharesOf(ctx, noteId, visibilities).select("id")
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.id);

/** How many shares `noteId` has, as {@link sharesOf} finds them. */
export const countSharesOf = async (
    ctx: Context,
    noteId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await sharesOf(ctx, noteId, visibilities).select(countAll).executeTakeFirstOrThrow(),
    );

/**
 * A page of the shares of a note with one of `visibilities`, but those of the accounts `blocked`,
 * newest first.
 */
export const sharePage = async (
    ctx: Context,
    noteId: string,
    visibilities: readonly Visibility[],
    blocked: Excluded | null,
    page: PageBounds,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("notes").selectAll()
        .where("reblog_of_id", "=", noteId)
        .where("visibility", "in", visibilities);
    if (blocked !== null) query = query.where(notExcluded(blocked, "notes.account_id"));

    return await readPage(query, "id", page);
};

/** How many shares the accounts `by` make of each of `noteIds` they share. */
export const countSharesBy = async (
    ctx: Context,
    noteIds: readonly string[],
    by: Excluded,
): Promise<Map<string, number>> => {
    if (noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("notes")
        .select((eb) => ["reblog_of_id", countAll(eb)])
        .where("reblog_of_id", "in", noteIds)
        .where(isExcluded(by, "notes.account_id"))
        .groupBy("reblog_of_id")
        .execute();
    return new Map(
        rows.flatMap((row) =>
            row.reblog_of_id === null ? [] : [[row.reblog_of_id, readCount(row)]]
        ),
    );
};
