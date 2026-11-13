import { hasAttachments } from "../media/attachment_queries.ts";
import type { Selectable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import { setsBy } from "../db/grouping.ts";
import type { Context } from "../kernel/context.ts";
import type { Visibility } from "../kernel/visibility.ts";
import type { NoteRow } from "./note_queries.ts";
import type { NotePinsTable } from "./tables.ts";

export type NotePinRow = Selectable<NotePinsTable>;

/** Pins a status for an account, unless it is already pinned. */
export const insertPin = async (ctx: Context, accountId: string, noteId: string): Promise<void> => {
    await ctx.db.insertInto("note_pins")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.columns(["account_id", "note_id"]).doNothing())
        .execute();
};

/** Unpins a status for an account. */
export const deletePin = async (ctx: Context, accountId: string, noteId: string): Promise<void> => {
    await ctx.db.deleteFrom("note_pins")
        .where("account_id", "=", accountId)
        .where("note_id", "=", noteId)
        .execute();
};

/** How many statuses an account has pinned. */
export const countPins = async (ctx: Context, accountId: string): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("note_pins").select(countAll)
            .where("account_id", "=", accountId)
            .executeTakeFirstOrThrow(),
    );

/** Which of `noteIds` each of `accountIds` has pinned, by account. */
export const pinnedAmong = async (
    ctx: Context,
    accountIds: readonly string[],
    noteIds: readonly string[],
): Promise<Map<string, Set<string>>> => {
    if (accountIds.length === 0 || noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("note_pins").select(["account_id", "note_id"])
        .where("account_id", "in", accountIds)
        .where("note_id", "in", noteIds)
        .execute();

    return setsBy(rows, (row) => row.account_id, (row) => row.note_id);
};

/** The statuses an account has pinned with one of `visibilities`, latest pinned first. */
export const pinnedNotes = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
    onlyMedia = false,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("note_pins")
        .innerJoin("notes", "notes.id", "note_pins.note_id")
        .selectAll("notes")
        .where("note_pins.account_id", "=", accountId)
        .where("notes.visibility", "in", visibilities);
    if (onlyMedia) query = query.where(hasAttachments);

    return await query.orderBy("note_pins.id", "desc").execute();
};
