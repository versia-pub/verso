import type { Insertable } from "kysely";
import { batchesOf } from "../db/batches.ts";
import type { Context } from "../kernel/context.ts";
import type { NotificationsTable } from "./tables.ts";

export const insertNotifications = async (
    ctx: Context,
    rows: readonly Insertable<NotificationsTable>[],
): Promise<void> => {
    for (const batch of batchesOf(rows)) {
        await ctx.db.insertInto("notifications").values(batch).execute();
    }
};

/** Deletes the notifications of the follow `followId`. Returns whether there were any. */
export const deleteFollowNotifications = async (
    ctx: Context,
    followId: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("notifications")
        .where("follow_id", "=", followId)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/** The accounts notified that `noteId` mentions them. */
export const mentionNotifiedIds = async (ctx: Context, noteId: string): Promise<Set<string>> =>
    new Set(
        (await ctx.db.selectFrom("notifications").select("account_id")
            .where("type", "=", "mention")
            .where("note_id", "=", noteId)
            .execute())
            .map((row) => row.account_id),
    );
