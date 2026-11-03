import type { Insertable, Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "../media/media_queries.ts";
import type { PreviewCardsTable } from "./tables.ts";

export type PreviewCardRow = Selectable<PreviewCardsTable>;

/** The card at `url`, if Verso has one. */
export const findCard = (ctx: Context, url: string): Promise<PreviewCardRow | undefined> =>
    ctx.db.selectFrom("preview_cards").selectAll().where("url", "=", url).executeTakeFirst();

/**
 * Saves `card`, replacing the card at the same address, and returns the id the card at that address
 * has. Two jobs that fetch the same page at once both end up with it.
 */
export const saveCard = async (
    ctx: Context,
    card: Insertable<PreviewCardsTable>,
): Promise<string> => {
    const { id: _id, url: _url, ...changes } = card;

    const saved = await ctx.db.insertInto("preview_cards")
        .values(card)
        .onConflict((conflict) => conflict.column("url").doUpdateSet(changes))
        .returning("id")
        .executeTakeFirstOrThrow();

    return saved.id;
};

/** The link the status `noteId` shows a card for, as it wrote it, if it shows one. */
export const linkOf = (ctx: Context, noteId: string): Promise<{ url: string } | undefined> =>
    ctx.db.selectFrom("note_preview_cards").select("url").where("note_id", "=", noteId)
        .executeTakeFirst();

/** Makes the card `cardId` the one the status `noteId` shows, for its link `url`. */
export const setLink = async (
    ctx: Context,
    noteId: string,
    cardId: string,
    url: string,
): Promise<void> => {
    await ctx.db.insertInto("note_preview_cards")
        .values({ note_id: noteId, card_id: cardId, url })
        .onConflict((conflict) => conflict.column("note_id").doUpdateSet({ card_id: cardId, url }))
        .execute();
};

/** Makes the status `noteId` show no card. */
export const removeLink = async (ctx: Context, noteId: string): Promise<void> => {
    await ctx.db.deleteFrom("note_preview_cards").where("note_id", "=", noteId).execute();
};

/** A card with its image. */
export type CardWithImage = PreviewCardRow & { readonly image: MediaRow | undefined };

/** A status's card, with the link it was shown for, and its image. */
export type NoteCard = CardWithImage & {
    readonly note_id: string;
    readonly link: string;
};

/** `cards` with their images. */
export const withImages = async <Card extends PreviewCardRow>(
    ctx: Context,
    cards: readonly Card[],
): Promise<(Card & { readonly image: MediaRow | undefined })[]> => {
    const imageIds = cards.flatMap((card) => card.image_id ?? []);
    const images = imageIds.length === 0 ? [] : await ctx.db.selectFrom("media").selectAll()
        .where("id", "in", imageIds)
        .execute();
    const byId = new Map(images.map((image) => [image.id, image]));

    return cards.map((card) => ({
        ...card,
        image: card.image_id === null ? undefined : byId.get(card.image_id),
    }));
};

/** The cards that the statuses `noteIds` show, by status. */
export const cardsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, NoteCard>> => {
    if (noteIds.length === 0) return new Map();

    const links = await ctx.db.selectFrom("note_preview_cards")
        .innerJoin("preview_cards", "preview_cards.id", "note_preview_cards.card_id")
        .selectAll("preview_cards")
        .select(["note_preview_cards.note_id", "note_preview_cards.url as link"])
        .where("note_preview_cards.note_id", "in", noteIds)
        .execute();

    return new Map((await withImages(ctx, links)).map((card) => [card.note_id, card]));
};
