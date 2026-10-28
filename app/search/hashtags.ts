/**
 * Finding hashtags by how they start, as Mastodon does.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/tag_search_service.rb
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { hashtagsStartingWith } from "./search_queries.ts";

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
