/**
 * Which links are trending, and which may trend. Its queries read the trending links, the preview
 * cards, the statuses that show them and their authors directly.
 * @module
 */
import { type Selectable, sql, type SqlBool } from "kysely";
import { batchesOf } from "../db/batches.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, notExcluded } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import { firstIdAt } from "../kernel/ids.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import type { Origin } from "../notes/timeline_queries.ts";
import type { PreviewCardRow } from "../previews/card_queries.ts";
import { dayOf } from "../search/hashtag_queries.ts";
import type { TrendingLinksTable } from "./tables.ts";

export type TrendingLink = Selectable<TrendingLinksTable>;

/** A card that is trending, with how much, whether or not an admin approved it. */
export type TrendingCard = PreviewCardRow & { readonly score: number };

/**
 * The statuses since `since` that share a card that could trend, and the cards: public statuses,
 * and public boosts of public statuses, but not of ones that are sensitive or have a content
 * warning. A card could trend if it is for an article with a title, a description, an image and a
 * provider, as Mastodon requires. Boosts count for the cards of the statuses they share.
 */
const sharesSince = (ctx: Pick<Context, "db">, since: Date) =>
    ctx.db.selectFrom("notes")
        .innerJoin(
            "notes as original",
            (join) => join.on(sql<SqlBool>`original.id = coalesce(notes.reblog_of_id, notes.id)`),
        )
        .innerJoin("note_preview_cards", "note_preview_cards.note_id", "original.id")
        .innerJoin("preview_cards", "preview_cards.id", "note_preview_cards.card_id")
        .where("notes.id", ">=", firstIdAt(since))
        .where("notes.created_at", ">=", since)
        .where("notes.visibility", "=", "public")
        .where("original.visibility", "=", "public")
        .where("original.spoiler_text", "=", "")
        .where("original.sensitive", "=", false)
        .where("preview_cards.link_type", "=", "article")
        .where("preview_cards.title", "<>", "")
        .where("preview_cards.description", "<>", "")
        .where("preview_cards.provider_name", "<>", "")
        .where("preview_cards.image_id", "is not", null);

/** The ids of the cards that at least `accounts` accounts shared since `since`. */
export const cardsSharedBy = async (
    ctx: Pick<Context, "db">,
    since: Date,
    accounts: number,
): Promise<string[]> => {
    const rows = await sharesSince(ctx, since)
        .select("preview_cards.id")
        .groupBy("preview_cards.id")
        .having((eb) => eb(eb.fn.count("notes.account_id").distinct(), ">=", accounts))
        .execute();

    return rows.map((row) => row.id);
};

/** How many statuses shared a card on one of the days asked about, and how many accounts. */
export type LinkDay = {
    readonly card_id: string;
    /** Which of the days. */
    readonly day: number;
    readonly uses: number;
    readonly accounts: number;
};

/**
 * How statuses and boosts shared each of the cards `cardIds` on each of the days that start at
 * `days`, newest first, each a day long, as {@link sharesSince} counts them. Days they weren't
 * shared are left out.
 *
 * Only statuses whose ids are from the oldest day on are counted, as {@link hashtagUses} does.
 */
export const linkUses = async (
    ctx: Pick<Context, "db">,
    cardIds: readonly string[],
    days: readonly Date[],
): Promise<LinkDay[]> => {
    const newest = days.at(0);
    const oldest = days.at(-1);
    if (cardIds.length === 0 || newest === undefined || oldest === undefined) return [];

    const day = dayOf(days);
    const rows = await sharesSince(ctx, oldest)
        .select((eb) => [
            "preview_cards.id as card_id",
            day.as("day"),
            eb.fn.countAll<number | string | bigint>().as("uses"),
            eb.fn.count<number | string | bigint>("notes.account_id").distinct().as("accounts"),
        ])
        .where("preview_cards.id", "in", cardIds)
        .where("notes.created_at", "<", new Date(newest.getTime() + 24 * 60 * 60 * 1000))
        .groupBy(["preview_cards.id", sql`day`])
        .execute();

    return rows.map((row) => ({
        card_id: row.card_id,
        day: Number(row.day),
        uses: Number(row.uses),
        accounts: Number(row.accounts),
    }));
};

/** The links that are trending, approved or not. */
export const trendingLinks = async (ctx: Context): Promise<TrendingLink[]> =>
    await ctx.db.selectFrom("trending_links").selectAll().execute();

/** Makes `rows` the links that are trending, and no others. */
export const replaceTrendingLinks = async (
    ctx: Context,
    rows: readonly TrendingLink[],
): Promise<void> => {
    const kept = new Set(rows.map((row) => row.card_id));
    const stale = (await ctx.db.selectFrom("trending_links").select("card_id").execute())
        .map((row) => row.card_id)
        .filter((id) => !kept.has(id));

    for (const batch of batchesOf(stale)) {
        await ctx.db.deleteFrom("trending_links").where("card_id", "in", batch).execute();
    }

    for (const batch of batchesOf(rows)) {
        await ctx.db.insertInto("trending_links")
            .values(batch)
            .onConflict((conflict) =>
                conflict.column("card_id").doUpdateSet((eb) => ({
                    score: eb.ref("excluded.score"),
                    max_score: eb.ref("excluded.max_score"),
                    max_score_at: eb.ref("excluded.max_score_at"),
                }))
            )
            .execute();
    }
};

/** The cards that are trending, the highest scoring first, approved or not. */
export const trendingCards = async (ctx: Context): Promise<TrendingCard[]> =>
    await ctx.db.selectFrom("trending_links")
        .innerJoin("preview_cards", "preview_cards.id", "trending_links.card_id")
        .selectAll("preview_cards")
        .select("trending_links.score")
        .orderBy("trending_links.score", "desc")
        .orderBy("preview_cards.id")
        .execute();

/** Whether links to each website an admin decided about may trend, by domain. */
export const providerDecisions = async (ctx: Context): Promise<Map<string, boolean>> =>
    new Map(
        (await ctx.db.selectFrom("preview_card_providers").selectAll().execute())
            .map((row) => [row.domain, row.trendable]),
    );

/** Sets whether links to the website `domain` may trend. */
export const setProviderTrendable = async (
    ctx: Context,
    domain: string,
    trendable: boolean,
): Promise<void> => {
    await ctx.db.insertInto("preview_card_providers")
        .values({ domain, trendable })
        .onConflict((conflict) => conflict.column("domain").doUpdateSet({ trendable }))
        .execute();
};

/** Sets whether the card at `url` may trend. Returns `false` if Verso has no such card. */
export const setCardTrendable = async (
    ctx: Context,
    url: string,
    trendable: boolean,
): Promise<boolean> => {
    const result = await ctx.db.updateTable("preview_cards")
        .set({ trendable })
        .where("url", "=", url)
        .executeTakeFirst();

    return result.numUpdatedRows > 0n;
};

/**
 * A page of the public statuses whose first link is the card `cardId`, newest first, as Mastodon
 * lists them: by accounts that are discoverable, and if there is a viewer, not by those they block
 * or mute, `hidden`, and only those from `origin`.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/link_feed.rb
 */
export const linkPage = async (
    ctx: Context,
    cardId: string,
    hidden: Excluded | null,
    page: PageBounds,
    origin: Origin = "all",
): Promise<NoteRow[]> => {
    const query = ctx.db.selectFrom("notes")
        .innerJoin("note_preview_cards", "note_preview_cards.note_id", "notes.id")
        .innerJoin("accounts", "accounts.id", "notes.account_id")
        .selectAll("notes")
        .where("note_preview_cards.card_id", "=", cardId)
        .where("notes.visibility", "=", "public")
        .where((eb) =>
            eb.or([
                eb("accounts.instance_id", "is not", null),
                eb("accounts.discoverable", "=", true),
            ])
        )
        .$if(origin === "local", (eb) => eb.where("notes.instance_id", "is", null))
        .$if(origin === "remote", (eb) => eb.where("notes.instance_id", "is not", null));

    return await readPage(
        hidden === null ? query : query.where(notExcluded(hidden, "notes.account_id")),
        "notes.id",
        page,
    );
};
