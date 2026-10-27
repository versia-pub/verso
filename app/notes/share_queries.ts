import { uncountStatusesFor } from "../accounts/count_queries.ts";
import type { Visibility } from "../accounts/tables.ts";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, isExcluded, notExcluded } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import type { NoteIdQuery } from "./removal_queries.ts";

/** Increments the boost count of a status, or decrements it when a boost is deleted. */
export const countShare = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ shares_count: eb("shares_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/**
 * Decrements the boost counts of the statuses boosted by `notes`. An account boosts a status once,
 * and `notes` all belong to one account.
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
 * Decrements the status counts of the accounts that boosted `noteId`, as the boosts are deleted
 * with it. Direct boosts aren't counted, so they aren't decremented.
 */
export const uncountSharersOf = (ctx: Context, noteId: string): Promise<void> =>
    uncountStatusesFor(
        ctx,
        ctx.db.selectFrom("notes").select("notes.account_id")
            .where("notes.reblog_of_id", "=", noteId)
            .where("notes.visibility", "!=", "direct"),
    );

/**
 * Decrements the status counts of the accounts that boosted `notes`, as the boosts are deleted
 * along with the statuses.
 */
export const uncountSharersOfAmong = (ctx: Context, notes: NoteIdQuery): Promise<void> =>
    uncountStatusesFor(
        ctx,
        ctx.db.selectFrom("notes").select("notes.account_id")
            .where("notes.reblog_of_id", "in", notes)
            .where("notes.visibility", "!=", "direct"),
    );

/** The local users who boosted `noteId`. */
export const localSharerIds = async (ctx: Context, noteId: string): Promise<string[]> =>
    (await ctx.db.selectFrom("notes").select("account_id")
        .where("reblog_of_id", "=", noteId)
        .where("instance_id", "is", null)
        .execute())
        .map((row) => row.account_id);

/** An account's boost of a status, if it boosts it. */
export const findShare = async (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll()
        .where("account_id", "=", accountId)
        .where("reblog_of_id", "=", noteId)
        .executeTakeFirst();

/** Removes an account's boost of a status, and returns it if there was one. */
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

/** Which of `noteIds` the account has boosted. */
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

/** The boosts of `noteId` with one of `visibilities`. */
const sharesOf = (ctx: Context, noteId: string, visibilities: readonly Visibility[]) =>
    ctx.db.selectFrom("notes")
        .where("reblog_of_id", "=", noteId)
        .where("visibility", "in", visibilities);

/** The ids of the boosts of `noteId`, as {@link sharesOf} finds them, oldest first. */
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

/** How many boosts `noteId` has, as {@link sharesOf} finds them. */
export const countSharesOf = async (
    ctx: Context,
    noteId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await sharesOf(ctx, noteId, visibilities).select(countAll).executeTakeFirstOrThrow(),
    );

/**
 * A page of the boosts of a status with one of `visibilities`, excluding those by the accounts
 * `blocked`, newest first.
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

/** How many boosts the accounts `by` made of each of `noteIds`. */
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
