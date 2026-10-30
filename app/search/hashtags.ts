/**
 * Finding hashtags by how they start, as Mastodon does.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/tag_search_service.rb
 * @module
 */
import type { Tag } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { displayNamesOf } from "../tags/tag_queries.ts";
import { hashtagsStartingWith, hashtagUses } from "./hashtag_queries.ts";

/** A search for hashtags. */
export type HashtagSearch = {
    /** A hashtag's start, with or without its `#`. */
    readonly query: string;
    readonly limit: number;
    readonly offset: number;
};

/** The names of the hashtags `search` finds, in lower case. */
export const searchHashtags = async (ctx: Context, search: HashtagSearch): Promise<string[]> => {
    const start = search.query.trim().replace(/^#/, "").toLowerCase();
    if (start === "") return [];

    return await hashtagsStartingWith(ctx, start, search.limit, search.offset);
};

const dayLength = 24 * 60 * 60 * 1000;

/**
 * The hashtags `names`, with how they were used on each of the past week's days, today first, in
 * UTC, as Mastodon shows them, by the names they were first written with. Each one's id is its name
 * in lower case.
 */
export const renderHashtags = async (ctx: Context, names: readonly string[]): Promise<Tag[]> => {
    const today = Math.floor(ctx.clock.now().getTime() / dayLength) * dayLength;
    const days = Array.from({ length: 7 }, (_, i) => new Date(today - i * dayLength));
    const displayNames = await displayNamesOf(ctx, names);
    const uses = new Map(
        (await hashtagUses(ctx, names, days)).map((used) => [`${used.name} ${used.day}`, used]),
    );

    return names.map((name) => ({
        id: name,
        name: displayNames.get(name) ?? name,
        url: ctx.urls.url`/tags/${name}`,
        history: days.map((day, i) => {
            const used = uses.get(`${name} ${i}`);
            return {
                day: String(day.getTime() / 1000),
                uses: String(used?.uses ?? 0),
                accounts: String(used?.accounts ?? 0),
            };
        }),
    }));
};
