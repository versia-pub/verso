import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media_queries.ts";

/** Whether a status has media attached, for status queries. */
export const hasAttachments = (
    eb: ExpressionBuilder<Database, "notes">,
): ExpressionWrapper<Database, "notes", SqlBool> =>
    eb.exists(
        eb.selectFrom("note_media").select("note_media.note_id")
            .whereRef("note_media.note_id", "=", "notes.id"),
    );

/** The ids in `ids` that are uploads by `accountId` and not attached to a status. */
export const unattachedUploads = async (
    ctx: Context,
    accountId: string,
    ids: readonly string[],
): Promise<MediaRow[]> => {
    if (ids.length === 0) return [];

    return await ctx.db.selectFrom("media").selectAll()
        .where("id", "in", ids)
        .where("account_id", "=", accountId)
        .where((eb) =>
            eb.not(eb.exists(
                eb.selectFrom("note_media").select("media_id").whereRef(
                    "note_media.media_id",
                    "=",
                    "media.id",
                ),
            ))
        )
        .execute();
};

/** Attaches the media `mediaIds` to the status `noteId`, in that order. */
export const insertAttachments = async (
    ctx: Context,
    noteId: string,
    mediaIds: readonly string[],
): Promise<void> => {
    if (mediaIds.length === 0) return;

    await ctx.db.insertInto("note_media")
        .values(mediaIds.map((media_id, position) => ({ note_id: noteId, media_id, position })))
        .execute();
};

/** Detaches all media from the status `noteId`. */
export const deleteAttachments = async (ctx: Context, noteId: string): Promise<void> => {
    await ctx.db.deleteFrom("note_media").where("note_id", "=", noteId).execute();
};

/** The media rows that exist for `ids`, in no particular order. */
export const findMediaRows = async (ctx: Context, ids: readonly string[]): Promise<MediaRow[]> =>
    ids.length === 0 ? [] : await ctx.db.selectFrom("media").selectAll().where("id", "in", ids)
        .execute();

/** The media attached to each of `noteIds`, in order, grouped by status. */
export const attachmentsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, MediaRow[]>> => {
    const attachments = new Map<string, MediaRow[]>();
    if (noteIds.length === 0) return attachments;

    const rows = await ctx.db.selectFrom("note_media")
        .innerJoin("media", "media.id", "note_media.media_id")
        .selectAll("media")
        .select("note_media.note_id")
        .where("note_media.note_id", "in", noteIds)
        .orderBy("note_media.position")
        .execute();
    for (const { note_id, ...row } of rows) {
        attachments.set(note_id, [...attachments.get(note_id) ?? [], row]);
    }

    return attachments;
};
