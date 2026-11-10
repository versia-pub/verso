import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";

/** Where a pass over preview cards has got to: the last one it looked at. */
export type CardPruneCursor = { readonly fetchedAt: Date; readonly id: string };

/**
 * Up to `limit` preview cards whose page was fetched before `before`, after `after`. Exported for
 * the tests of its query plan.
 */
export const oldCardsQuery = (
    ctx: Context,
    before: Date,
    after: CardPruneCursor | undefined,
    limit: number,
): SelectQueryBuilder<Database, "preview_cards", { id: string; fetched_at: Date }> => {
    let query = ctx.db.selectFrom("preview_cards").select(["id", "fetched_at"])
        .where("fetched_at", "<", before);
    if (after) {
        query = query.where((eb) =>
            eb(eb.refTuple("fetched_at", "id"), ">", eb.tuple(after.fetchedAt, after.id))
        );
    }

    return query.orderBy("fetched_at").orderBy("id").limit(limit);
};

/**
 * Deletes those of the cards `ids`, at least one, fetched before `before` that no status shows,
 * that aren't trending, and that no admin approved or rejected for trends, so the decision stays.
 * Returns how many it deleted.
 */
export const deleteUnusedCards = async (
    ctx: Context,
    ids: readonly string[],
    before: Date,
): Promise<number> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("preview_cards")
        .where("id", "in", ids)
        .where("fetched_at", "<", before)
        .where("trendable", "is", null)
        .where((eb) =>
            eb.not(eb.or([
                eb.exists(
                    eb.selectFrom("note_preview_cards").select("note_preview_cards.card_id")
                        .whereRef("note_preview_cards.card_id", "=", "preview_cards.id"),
                ),
                eb.exists(
                    eb.selectFrom("trending_links").select("trending_links.card_id")
                        .whereRef("trending_links.card_id", "=", "preview_cards.id"),
                ),
            ]))
        )
        .executeTakeFirst();

    return Number(numDeletedRows);
};

/**
 * Takes the images off those of the cards `ids`, at least one, fetched before `before`, as Mastodon
 * does, and returns how many lost one. The media they used is removed with other unused media.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/lib/vacuum/preview_cards_vacuum.rb
 */
export const clearCardImages = async (
    ctx: Context,
    ids: readonly string[],
    before: Date,
): Promise<number> => {
    const { numUpdatedRows } = await ctx.db.updateTable("preview_cards")
        .set({ image_id: null })
        .where("id", "in", ids)
        .where("fetched_at", "<", before)
        .where("image_id", "is not", null)
        .executeTakeFirst();

    return Number(numUpdatedRows);
};
