import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media.ts";

/** Whether a note has files attached, for queries of notes. */
export const hasAttachments = (
    eb: ExpressionBuilder<Database, "notes">,
): ExpressionWrapper<Database, "notes", SqlBool> =>
    eb.exists(
        eb.selectFrom("note_media").select("note_media.note_id")
            .whereRef("note_media.note_id", "=", "notes.id"),
    );

/** Of `ids`, the uploads `accountId` made that aren't attached to a note. */
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

/** Attaches the files `mediaIds` to the note `noteId`, in that order. */
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

/** Detaches every file attached to the note `noteId`. */
export const deleteAttachments = async (ctx: Context, noteId: string): Promise<void> => {
    await ctx.db.deleteFrom("note_media").where("note_id", "=", noteId).execute();
};

/** The files of `ids` that exist, in no order. */
export const findMediaRows = async (ctx: Context, ids: readonly string[]): Promise<MediaRow[]> =>
    ids.length === 0 ? [] : await ctx.db.selectFrom("media").selectAll().where("id", "in", ids)
        .execute();

/** The files attached to each of `noteIds`, in order, by note. */
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
