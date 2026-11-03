/**
 * Trending links: which preview cards may be shown as trending, and how they are shown. A card
 * trends if an admin approved it, or else its website or a parent domain of it, or else the
 * instance's default approves, as Mastodon decides.
 * @module
 */
import type { TrendsLink } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { withImages } from "../previews/card_queries.ts";
import { renderCard } from "../previews/render.ts";
import { linkUses, providerDecisions, type TrendingCard, trendingCards } from "./link_queries.ts";
import { cardState } from "./review.ts";

/** The trending cards that may be shown, the highest scoring first. */
export const approvedTrendingCards = async (
    ctx: Context,
    byDefault: boolean,
): Promise<TrendingCard[]> => {
    const decisions = await providerDecisions(ctx);

    return (await trendingCards(ctx))
        .filter((card) => cardState(card, decisions, byDefault) === "approved");
};

const dayLength = 24 * 60 * 60 * 1000;

/**
 * The cards `cards` as Mastodon renders trending links: with how they were shared on each of the
 * past week's days, today first, in UTC. A link's `url` is its card's, which is what the link
 * timeline looks cards up by.
 */
export const renderTrendingLinks = async (
    ctx: Context,
    cards: readonly TrendingCard[],
): Promise<TrendsLink[]> => {
    const today = Math.floor(ctx.clock.now().getTime() / dayLength) * dayLength;
    const days = Array.from({ length: 7 }, (_, i) => new Date(today - i * dayLength));
    const uses = new Map(
        (await linkUses(ctx, cards.map((card) => card.id), days))
            .map((used) => [`${used.card_id} ${used.day}`, used]),
    );

    return (await withImages(ctx, cards)).map((card) => ({
        ...renderCard(ctx, card, card.url),
        history: days.map((day, i) => {
            const used = uses.get(`${card.id} ${i}`);
            return {
                day: String(day.getTime() / 1000),
                uses: String(used?.uses ?? 0),
                accounts: String(used?.accounts ?? 0),
            };
        }),
    }));
};
