import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { SelectQueryBuilder } from "kysely";

/** Notes' ids, as a subquery. */
export type NoteIdQuery = SelectQueryBuilder<Database, keyof Database, { id: string }>;

/** The notes and shares of `accountId`, as a subquery. */
export const notesOfQuery = (ctx: Context, accountId: string): NoteIdQuery =>
    ctx.db.selectFrom("notes").select("notes.id").where("notes.account_id", "=", accountId);

/** The notes `ids`, at least one, as a subquery. */
export const notesAmongQuery = (ctx: Context, ids: readonly string[]): NoteIdQuery =>
    ctx.db.selectFrom("notes").select("notes.id").where("notes.id", "in", ids);

/** The ids of up to `limit` of the notes and shares of `accountId`. */
export const someNoteIdsOf = async (
    ctx: Context,
    accountId: string,
    limit: number,
): Promise<string[]> =>
    (await ctx.db.selectFrom("notes").select("id").where("account_id", "=", accountId)
        .limit(limit).execute()).map((row) => row.id);

/** Deletes the notes `ids`, at least one, with what goes with them, without uncounting anything. */
export const deleteNotes = async (ctx: Context, ids: readonly string[]): Promise<void> => {
    await ctx.db.deleteFrom("notes").where("id", "in", ids).execute();
};

/** Uncounts the public and unlisted replies among `notes` from the notes they reply to. */
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
        // Only the notes it replied to, rather than every note, less nothing.
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as reply").select("reply.in_reply_to_id")
                .where("reply.id", "in", notes))
        .execute();
};
