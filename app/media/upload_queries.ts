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
