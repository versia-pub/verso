/**
 * Reading a status search's query as Mastodon does: words, quoted phrases and hashtags that a
 * status must have, or with a `-`, mustn't, and the prefixes Mastodon knows, such as `from:` and
 * `before:`. A `prefix:` Mastodon doesn't know is searched as words.
 * @see https://github.com/mastodon/mastodon/blob/main/app/lib/search_query_parser.rb
 * @see https://github.com/mastodon/mastodon/blob/main/app/lib/search_query_transformer.rb
 * @module
 */
import { HttpError } from "../http/errors.ts";
import type { NoteScope, NoteTerm } from "./search_queries.ts";
import { searchWords } from "./words.ts";

/**
 * A term of a query: one of {@link NoteTerm}, or `from:`'s author, by how the query names them,
 * which is `me` or an address.
 */
export type QueryTerm =
    | Exclude<NoteTerm, { readonly kind: "author" }>
    | { readonly kind: "from"; readonly account: string; readonly negated: boolean };

/** What a status search's query asks for. */
export type StatusQuery = {
    readonly terms: readonly QueryTerm[];
    /** Which statuses to search, if `in:` says. */
    readonly scope: NoteScope | null;
};

/**
 * A clause: an optional `+` or `-`, an optional prefix ending in `:`, then a quoted phrase, whose
 * closing quote may be missing, or a term.
 */
const clausePattern = /([+-]?)(?:([^\s":]+):)?(?:"([^"]*)"?|(\S+))/gu;

const dayLength = 24 * 60 * 60 * 1000;

/**
 * The time `value` names, from its start until just before its end: a day, `yyyy-MM-dd`, in UTC,
 * as Verso knows no user's time zone, or a millisecond since 1970, as on Mastodon.
 */
const timeOf = (value: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const start = new Date(`${value}T00:00:00Z`);
        // Days that don't exist, such as 2024-02-30, aren't read as others.
        if (!Number.isNaN(start.getTime()) && start.toISOString().startsWith(value)) {
            return { start, end: new Date(start.getTime() + dayLength) };
        }
    }

    // Mastodon takes up to 19 digits, but more than 16 are past what a date can be.
    if (/^\d+$/.test(value)) {
        const start = new Date(Number(value));
        if (!Number.isNaN(start.getTime())) return { start, end: new Date(start.getTime() + 1) };
    }

    // Mastodon's error.
    throw new HttpError(422, `Invalid date ${value}`);
};

/** The term that the prefix Mastodon knows `prefix` makes of `value`, if it is one. */
const prefixed = (prefix: string, value: string, negated: boolean): QueryTerm | undefined => {
    switch (prefix) {
        case "has":
        case "is":
            return { kind: "property", property: value, negated };
        case "language":
            // As statuses' languages are kept: `en` for `en-US`.
            return { kind: "language", language: value.toLowerCase().split(/[-_]/)[0], negated };
        case "from":
            return { kind: "from", account: value, negated };
        case "before":
            return { kind: "created", since: null, until: timeOf(value).start, negated };
        case "after":
            return { kind: "created", since: timeOf(value).end, until: null, negated };
        case "during": {
            const { start, end } = timeOf(value);
            return { kind: "created", since: start, until: end, negated };
        }
    }
};

/** The term a clause makes, if it has anything to find. */
const termOf = (
    sign: string,
    prefix: string | undefined,
    phrase: string | undefined,
    term = "",
): QueryTerm | undefined => {
    const negated = sign === "-";

    const known = prefix && prefixed(prefix.toLowerCase(), phrase ?? term, negated);
    if (known) return known;

    // A phrase leaves the term empty.
    if (prefix === undefined && term.startsWith("#")) {
        const name = term.slice(1).toLowerCase();
        return name === "" ? undefined : { kind: "hashtag", values: [name], negated };
    }

    const words = searchWords([prefix, phrase ?? term].join(" "));
    if (words.length === 0) return undefined;

    const kind = phrase !== undefined && prefix === undefined ? "phrase" : "words";
    return { kind, values: words, negated };
};

/**
 * What a status must and mustn't have to be found by `query`, and where. A date Mastodon wouldn't
 * read is refused.
 */
export const parseStatusQuery = (query: string): StatusQuery => {
    const terms = [];
    let scope: NoteScope | null = null;

    for (const [, sign, prefix, phrase, term] of query.matchAll(clausePattern)) {
        // Which statuses to search, whatever its sign, as on Mastodon.
        if (prefix?.toLowerCase() === "in") {
            const value = phrase ?? term;
            scope = value === "library" || value === "public" ? value : "all";
            continue;
        }

        const found = termOf(sign, prefix, phrase, term);
        if (found) terms.push(found);
    }

    return { terms, scope };
};
