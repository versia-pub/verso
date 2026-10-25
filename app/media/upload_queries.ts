import type { Insertable, Updateable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media.ts";
import type { MediaTable } from "./tables.ts";

/** What processing an upload sets: the file it is kept as, and what is known of it. */
export type Processed = Pick<
    Updateable<MediaTable>,
    | "sha256"
    | "size"
    | "media_type"
    | "width"
    | "height"
    | "thumbhash"
    | "blurhash"
    | "preview_sha256"
    | "preview_width"
    | "preview_height"
>;

export const insertUpload = async (ctx: Context, row: Insertable<MediaTable>): Promise<void> => {
    await ctx.db.insertInto("media").values(row).execute();
};

/** A processed upload of the same file as was uploaded as `uploadSha256`, if there is one. */
export const processedUpload = (
    ctx: Context,
    uploadSha256: string,
): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll()
        .where("upload_sha256", "=", uploadSha256)
        .where("processed_at", "is not", null)
        .executeTakeFirst();

/** Marks the upload `id` processed, unless it is already. Returns whether it was. */
export const finishUpload = async (
    ctx: Context,
    id: string,
    processed: Processed,
): Promise<boolean> => {
    const { numUpdatedRows } = await ctx.db.updateTable("media")
        .set({ ...processed, processed_at: ctx.clock.now() })
        .where("id", "=", id)
        .where("processed_at", "is", null)
        .executeTakeFirst();

    return numUpdatedRows > 0n;
};

/**
 * Whether any file is kept under `key`, or its preview is, or an upload of it is waiting to be
 * processed.
 */
export const isFileUsed = async (ctx: Context, key: string): Promise<boolean> =>
    await ctx.db.selectFrom("media").select("id")
        .where((eb) =>
            eb.or([
                eb("sha256", "=", key),
                eb("preview_sha256", "=", key),
                eb.and([eb("upload_sha256", "=", key), eb("processed_at", "is", null)]),
            ])
        )
        .where("instance_id", "is", null)
        .executeTakeFirst() !== undefined;

/** The upload `id`, if `accountId` uploaded it. */
export const findUpload = (
    ctx: Context,
    id: string,
    accountId: string,
): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll()
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** Changes how the upload `id` is described, if `accountId` uploaded it. */
export const updateUpload = async (
    ctx: Context,
    id: string,
    accountId: string,
    changes: Pick<Updateable<MediaTable>, "description" | "focus_x" | "focus_y">,
): Promise<void> => {
    await ctx.db.updateTable("media")
        .set(changes)
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .execute();
};

/** An upload kept under `key` once it is processed, or whose preview is. Only local ones are. */
export const findServedFile = (
    ctx: Context,
    key: string,
): Promise<Pick<MediaRow, "media_type" | "preview_sha256"> | undefined> =>
    ctx.db.selectFrom("media").select(["media_type", "preview_sha256"])
        .where((eb) =>
            eb.or([
                eb.and([eb("sha256", "=", key), eb("processed_at", "is not", null)]),
                eb("preview_sha256", "=", key),
            ])
        )
        .executeTakeFirst();

/** Where removing unused uploads got to: the last one it looked at, in the order it looks. */
export type UploadCursor = Pick<MediaRow, "created_at" | "id">;

/** An upload that was removed, with the keys it kept files under. */
export type RemovedUpload =
    & UploadCursor
    & Pick<MediaRow, "sha256" | "preview_sha256" | "upload_sha256">;

/**
 * Removes up to `limit` uploads made by `before` that nothing uses, oldest first, after the one
 * at `after`: no note has them attached, and no account or emoji shows them. A note given one at
 * the same time makes it fail instead, as attached files can't be deleted.
 */
export const deleteUnusedUploads = (
    ctx: Context,
    before: Date,
    after: UploadCursor | undefined,
    limit: number,
): Promise<RemovedUpload[]> =>
    ctx.db.deleteFrom("media")
        .where("id", "in", (eb) => {
            let unused = eb.selectFrom("media as unused").select("unused.id")
                // Only uploads have someone who uploaded them.
                .where("unused.account_id", "is not", null)
                .where("unused.created_at", "<=", before);
            if (after) {
                unused = unused.where(
                    (eb) =>
                        eb(
                            eb.refTuple("unused.created_at", "unused.id"),
                            ">",
                            eb.tuple(after.created_at, after.id),
                        ),
                );
            }

            return unused
                .where((eb) =>
                    eb.not(eb.or([
                        eb.exists(
                            eb.selectFrom("note_media").select("note_media.media_id")
                                .whereRef("note_media.media_id", "=", "unused.id"),
                        ),
                        eb.exists(
                            eb.selectFrom("accounts").select("accounts.id").where((eb) =>
                                eb.or([
                                    eb("accounts.avatar_id", "=", eb.ref("unused.id")),
                                    eb("accounts.header_id", "=", eb.ref("unused.id")),
                                ])
                            ),
                        ),
                        eb.exists(
                            eb.selectFrom("emojis").select("emojis.id")
                                .whereRef("emojis.media_id", "=", "unused.id"),
                        ),
                    ]))
                )
                .orderBy("unused.created_at")
                .orderBy("unused.id")
                .limit(limit);
        })
        .returning(["created_at", "id", "sha256", "preview_sha256", "upload_sha256"])
        .execute();
