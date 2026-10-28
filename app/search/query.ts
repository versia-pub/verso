/**
 * Reading a status search's query as Mastodon does: words, quoted phrases and hashtags that a
 * status must have, or with a `-`, mustn't. A `prefix:` Mastodon doesn't know is searched as words.
 * @see https://github.com/mastodon/mastodon/blob/main/app/lib/search_query_parser.rb
 * @see https://github.com/mastodon/mastodon/blob/main/app/lib/search_query_transformer.rb
 * @module
 */
import type { NoteTerm } from "./search_queries.ts";
import { searchWords } from "./words.ts";

/**
 * A clause: an optional `+` or `-`, an optional prefix ending in `:`, then a quoted phrase, whose
 * closing quote may be missing, or a term.
 */
const clausePattern = /([+-]?)(?:([^\s":]+):)?(?:"([^"]*)"?|(\S+))/gu;

/** The term a clause of `query` makes, if it has anything to find. */
const termOf = (
    sign: string,
    prefix: string | undefined,
    phrase: string | undefined,
    term = "",
) => {
    const negated = sign === "-";

    // A phrase leaves the term empty.
    if (prefix === undefined && term.startsWith("#")) {
        const name = term.slice(1).toLowerCase();
        return name === "" ? undefined : { kind: "hashtag", values: [name], negated } as const;
    }

    const words = searchWords([prefix, phrase ?? term].join(" "));
    if (words.length === 0) return undefined;

    const kind = phrase !== undefined && prefix === undefined ? "phrase" : "words";
    return { kind, values: words, negated } as const;
};

/** What a status must and mustn't have to be found by `query`. */
export const parseStatusQuery = (query: string): NoteTerm[] =>
    [...query.matchAll(clausePattern)].flatMap(([, sign, prefix, phrase, term]) =>
        termOf(sign, prefix, phrase, term) ?? []
    );
