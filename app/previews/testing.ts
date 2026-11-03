import type { Insertable } from "kysely";
import type { Context } from "../kernel/context.ts";
import { saveCard, setLink } from "./card_queries.ts";
import type { PreviewCardsTable } from "./tables.ts";

/**
 * A card for an article, with a stored image, that the statuses `noteIds` show, for the link they
 * wrote, the card's `url` unless `card` says otherwise. Returns its id.
 */
export const createCard = async (
    ctx: Context,
    noteIds: readonly string[],
    card: Partial<Insertable<PreviewCardsTable>> = {},
): Promise<string> => {
    const imageId = ctx.ids();
    await ctx.db.insertInto("media")
        .values({
            id: imageId,
            instance_id: null,
            url: null,
            media_type: "image/png",
            sha256: `card-${imageId}`,
            processed_at: ctx.clock.now(),
            created_at: ctx.clock.now(),
        })
        .execute();

    const url = card.url ?? `https://news.example/${ctx.ids()}`;
    const id = await saveCard(ctx, {
        id: ctx.ids(),
        url,
        title: "A story",
        description: "What happened",
        language: null,
        author_name: "",
        author_url: "",
        provider_name: "News",
        provider_url: "https://news.example",
        image_id: imageId,
        image_description: "",
        published_at: null,
        link_type: "article",
        fetched_at: ctx.clock.now(),
        ...card,
    });
    for (const noteId of noteIds) await setLink(ctx, noteId, id, url);

    return id;
};
