import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Up to `limit` remote media attached to statuses whose file was cached before `before`, with the
 * keys of their files. Exported for the tests of its query plan.
 */
export const oldCachedQuery = (
    ctx: Context,
    before: Date,
    limit: number,
): SelectQueryBuilder<
    Database,
    "media",
    { id: string; sha256: string; preview_sha256: string | null }
> => ctx.db.selectFrom("media")
    .select(["id", "sha256", "preview_sha256"])
    .where("instance_id", "is not", null)
    .where("processed_at", "<", before)
    .where("sha256", "is not", null)
    .where((eb) =>
        eb.exists(
            eb.selectFrom("note_media").select("note_media.media_id")
                .whereRef("note_media.media_id", "=", "media.id"),
        )
    )
    .limit(limit)
    .$narrowType<{ sha256: string }>();

/**
 * Marks those of the remote media `ids`, at least one, cached before `before` as not cached, so
 * that the media proxy fetches them again when asked for, as Mastodon does. What is known of them,
 * such as their size and blurhash, is kept. Returns how many it marked.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/lib/vacuum/media_attachments_vacuum.rb
 */
export const uncacheMedia = async (
    ctx: Context,
    ids: readonly string[],
    before: Date,
): Promise<number> => {
    const { numUpdatedRows } = await ctx.db.updateTable("media")
        .set({ sha256: null, preview_sha256: null, cached_type: null, processed_at: null })
        .where("id", "in", ids)
        .where("processed_at", "<", before)
        .where("sha256", "is not", null)
        .executeTakeFirst();

    return Number(numUpdatedRows);
};
