import type { PreviewCard } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { fileUrl } from "../media/render.ts";
import type { CardWithImage } from "./card_queries.ts";

/**
 * A card as Mastodon's API renders it. It is always a link: Verso makes no embeds. Its image is
 * the stored copy, once processed. `url` is the link to show: for a status, the one it wrote.
 * @see https://docs.joinmastodon.org/entities/PreviewCard/
 */
export const renderCard = (ctx: Context, card: CardWithImage, url: string): PreviewCard => {
    const image = card.image?.sha256 ? card.image : undefined;

    return {
        url,
        title: card.title,
        description: card.description,
        language: card.language,
        type: "link",
        authors: card.author_name === ""
            ? []
            : [{ name: card.author_name, url: card.author_url, account: null }],
        author_name: card.author_name,
        author_url: card.author_url,
        provider_name: card.provider_name,
        provider_url: card.provider_url,
        html: "",
        width: image?.width ?? 0,
        height: image?.height ?? 0,
        image: image?.sha256 ? fileUrl(ctx, image.sha256) : null,
        image_description: card.image_description,
        embed_url: "",
        blurhash: image?.blurhash ?? null,
        published_at: card.published_at?.toISOString() ?? null,
    };
};
