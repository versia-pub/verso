import type { Insertable, Updateable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media_queries.ts";
import type { MediaTable } from "./tables.ts";

/** What processing an upload sets: the file it is stored as, and its metadata. */
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

/** A processed and stored upload of the same file as `uploadSha256`, if there is one. */
export const processedUpload = (
    ctx: Context,
    uploadSha256: string,
): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll()
        .where("upload_sha256", "=", uploadSha256)
        .where("processed_at", "is not", null)
        .where("sha256", "is not", null)
        .executeTakeFirst();

/** Marks the upload `id` as processed, unless it already is. Returns whether it changed. */
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
 * Whether any media is stored under `key`, or has it as its preview, or an upload of it is waiting
 * to be processed.
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

/** Updates the description of the upload `id`, if `accountId` uploaded it. */
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

/**
 * An upload stored under `key` once processed, or having it as its preview. Only local media
 * qualifies.
 */
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

/**
 * How far removal of unused media got: the last row it looked at, in the order it processes them.
 */
export type MediaCursor = Pick<MediaRow, "created_at" | "id">;

/** Removed media, with its location and the keys of the files a local one stored. */
export type RemovedMedia =
    & MediaCursor
    & Pick<MediaRow, "instance_id" | "sha256" | "preview_sha256" | "upload_sha256">;

/**
 * Removes up to `limit` media rows created before `before` that nothing uses, local or remote,
 * oldest first, starting after the row at `after`. Media is unused when no status has it attached
 * and no account or custom emoji uses it. Anything that starts using media must be added here. If a
 * status gets attached to the media at the same moment, the removal fails instead, since attached
 * media can't be deleted. It reads the `accounts` and `emojis` tables directly rather than going
 * through their modules, so that it is a single query.
 */
export const deleteUnusedMedia = (
    ctx: Context,
    before: Date,
    after: MediaCursor | undefined,
    limit: number,
): Promise<RemovedMedia[]> =>
    ctx.db.deleteFrom("media")
        .where("id", "in", (eb) => {
            let unused = eb.selectFrom("media as unused").select("unused.id")
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
        .returning(["created_at", "id", "instance_id", "sha256", "preview_sha256", "upload_sha256"])
        .execute();
