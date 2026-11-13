import type { Selectable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { ScheduledNotesTable } from "./tables.ts";

export type ScheduledNoteRow = Selectable<ScheduledNotesTable>;

export const insertScheduled = async (ctx: Context, row: ScheduledNoteRow): Promise<void> => {
    await ctx.db.insertInto("scheduled_notes").values(row).execute();
};

/** `accountId`'s scheduled status `id`, if it is theirs. */
export const findScheduled = (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<ScheduledNoteRow | undefined> =>
    ctx.db.selectFrom("scheduled_notes").selectAll()
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** A page of `accountId`'s scheduled statuses, by id, the last scheduled first. */
export const scheduledPage = (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<ScheduledNoteRow[]> =>
    readPage(
        ctx.db.selectFrom("scheduled_notes").selectAll().where("account_id", "=", accountId),
        "scheduled_notes.id",
        page,
    );

/**
 * How many statuses `accountId` scheduled, other than `exceptId`, at any time, or from `from` until
 * just before `until`.
 */
export const countScheduled = async (
    ctx: Context,
    accountId: string,
    exceptId: string | null,
    during?: { readonly from: Date; readonly until: Date },
): Promise<number> => {
    let query = ctx.db.selectFrom("scheduled_notes")
        .select(countAll)
        .where("account_id", "=", accountId);
    if (exceptId !== null) query = query.where("id", "!=", exceptId);
    if (during) {
        query = query.where("scheduled_at", ">=", during.from)
            .where("scheduled_at", "<", during.until);
    }

    return readCount(await query.executeTakeFirstOrThrow());
};

export const setScheduledAt = async (ctx: Context, id: string, at: Date): Promise<void> => {
    await ctx.db.updateTable("scheduled_notes").set({ scheduled_at: at }).where("id", "=", id)
        .execute();
};

/** Deletes the scheduled status `id`, and returns whether it was there to delete. */
export const deleteScheduled = async (ctx: Context, id: string): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("scheduled_notes").where("id", "=", id)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/**
 * Up to `limit` of the scheduled statuses that are due by now, the first due first. Those of
 * suspended users wait until they aren't.
 */
export const dueScheduled = (ctx: Context, limit: number): Promise<ScheduledNoteRow[]> =>
    ctx.db.selectFrom("scheduled_notes")
        .innerJoin("accounts", "accounts.id", "scheduled_notes.account_id")
        .selectAll("scheduled_notes")
        .where("scheduled_notes.scheduled_at", "<=", ctx.clock.now())
        .where("accounts.suspended_at", "is", null)
        .orderBy("scheduled_notes.scheduled_at")
        .orderBy("scheduled_notes.id")
        .limit(limit)
        .execute();
