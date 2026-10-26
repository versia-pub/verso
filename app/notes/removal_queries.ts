import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { SelectQueryBuilder } from "kysely";

/** Status ids, as a subquery. */
export type NoteIdQuery = SelectQueryBuilder<Database, keyof Database, { id: string }>;

/** The statuses and boosts of `accountId`, as a subquery. */
export const notesOfQuery = (ctx: Context, accountId: string): NoteIdQuery =>
    ctx.db.selectFrom("notes").select("notes.id").where("notes.account_id", "=", accountId);

/** The statuses `ids`, at least one, as a subquery. */
export const notesAmongQuery = (ctx: Context, ids: readonly string[]): NoteIdQuery =>
    ctx.db.selectFrom("notes").select("notes.id").where("notes.id", "in", ids);

/** The ids of up to `limit` of the statuses and boosts of `accountId`. */
export const someNoteIdsOf = async (
    ctx: Context,
    accountId: string,
    limit: number,
): Promise<string[]> =>
    (await ctx.db.selectFrom("notes").select("id").where("account_id", "=", accountId)
        .limit(limit).execute()).map((row) => row.id);

/**
 * Deletes the statuses `ids`, at least one, with their dependent rows, without updating any counts.
 */
export const deleteNotes = async (ctx: Context, ids: readonly string[]): Promise<void> => {
    await ctx.db.deleteFrom("notes").where("id", "in", ids).execute();
};

/**
 * Decrements the reply counts of the statuses replied to by the public and unlisted replies among
 * `notes`.
 */
export const uncountRepliesAmong = async (ctx: Context, notes: NoteIdQuery): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({
            replies_count: eb(
                "replies_count",
                "-",
                eb.selectFrom("notes as reply")
                    .select((count) => count.fn.countAll<number>().as("count"))
                    .whereRef("reply.in_reply_to_id", "=", "notes.id")
                    .where("reply.id", "in", notes)
                    .where("reply.visibility", "in", ["public", "unlisted"]),
            ),
        }))
        // Only update the statuses replied to, rather than every status (where it would subtract 0).
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as reply").select("reply.in_reply_to_id")
                .where("reply.id", "in", notes))
        .execute();
};
