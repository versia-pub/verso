/**
 * Finding statuses by the start of their words, among those Mastodon searches: public statuses by
 * authors who chose to be `indexable`, and those the viewer wrote, was mentioned in, liked or
 * boosted. Only signed-in users search statuses, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/search/#v2
 * @module
 */
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes, type NoteRow } from "../notes/note_queries.ts";
import { signedInOnlooker } from "../notes/visibility.ts";
import { noteIdsMatching } from "./search_queries.ts";
import { parseStatusQuery, type QueryTerm } from "./query.ts";
import type { NoteTerm } from "./search_queries.ts";

/** A search for statuses. */
export type StatusSearch = {
    /** Words, phrases and hashtags, as {@link parseStatusQuery} reads them. */
    readonly query: string;
    /** Who is searching. */
    readonly viewerId: string;
    /** The author to find statuses of, if only one's. */
    readonly accountId: string | null;
    /** The id statuses must be newer than, if any. */
    readonly minId: string | null;
    /** The id statuses must be older than, if any. */
    readonly maxId: string | null;
    readonly limit: number;
    readonly offset: number;
};

/**
 * `term`, with `from:`'s author found among the accounts Verso has: the viewer for `me`, as on
 * Mastodon, or the account at the address given, if there is one.
 */
const authorOf = async (ctx: Context, term: QueryTerm, viewerId: string): Promise<NoteTerm> => {
    if (term.kind !== "from") return term;
    if (term.account === "me") {
        return { kind: "author", accountId: viewerId, negated: term.negated };
    }

    const address = parseAddress(ctx, term.account);
    const account = address && await findAccountByAddress(ctx, address, { fetch: false });
    return { kind: "author", accountId: account?.id ?? null, negated: term.negated };
};

/**
 * The statuses `search` finds, newest first: those with what its query says, that the viewer may
 * see, by authors they don't block or mute.
 */
export const searchStatuses = async (ctx: Context, search: StatusSearch): Promise<NoteRow[]> => {
    const { viewerId } = search;
    const query = parseStatusQuery(search.query);

    const terms = [];
    for (const term of query.terms) terms.push(await authorOf(ctx, term, viewerId));

    const ids = await noteIdsMatching(ctx, terms, {
        ...search,
        scope: query.scope,
        onlooker: signedInOnlooker(ctx, viewerId),
        hidden: hiddenFrom(ctx, viewerId),
    });

    const found = new Map((await findNotes(ctx, ids)).map((note) => [note.id, note]));
    return ids.flatMap((id) => found.get(id) ?? []);
};
