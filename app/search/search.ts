/**
 * Searching accounts, statuses and hashtags at once, as Mastodon's `/api/v2/search` does, or what a
 * URL names when asked to resolve it.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/search_service.rb
 * @module
 */
import type { AccountRow } from "../accounts/account_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { searchAccounts } from "./accounts.ts";
import { searchHashtags } from "./hashtags.ts";
import { searchStatuses } from "./statuses.ts";
import { isUrlQuery, resolveUrl } from "./urls.ts";

/** What can be searched for. */
export type SearchType = "accounts" | "hashtags" | "statuses";

/** A search of everything, or of one type. */
export type ContentSearch = {
    readonly query: string;
    /** Only this type, if given. */
    readonly type: SearchType | undefined;
    /** Who is searching, if anyone is signed in. */
    readonly viewerId: string | null;
    /** Whether to fetch the account at an address, or what a URL names, if Verso hasn't it. */
    readonly resolve: boolean;
    /** Whether to find only the viewer and the accounts they follow. */
    readonly following: boolean;
    /** The author to find statuses of, if only one's. */
    readonly accountId: string | null;
    readonly minId: string | null;
    readonly maxId: string | null;
    /** How many of each type to find. */
    readonly limit: number;
    /** How many of each to skip, which only a search of one type does. */
    readonly offset: number | undefined;
};

/** What a search found, of each type. */
export type SearchResults = {
    readonly accounts: readonly AccountRow[];
    readonly statuses: readonly NoteRow[];
    readonly hashtags: readonly string[];
};

const nothing: SearchResults = { accounts: [], statuses: [], hashtags: [] };

/**
 * What `search` finds, as Mastodon finds it. A URL is all a search that resolves looks for: what
 * it names, on the first page, if it is of the type wanted. Otherwise each type wanted is searched,
 * statuses only for a viewer, skipping `offset` of each only if there is one type.
 */
export const searchAll = async (ctx: Context, search: ContentSearch): Promise<SearchResults> => {
    const { viewerId, limit } = search;
    const wants = (type: SearchType) => search.type === undefined || search.type === type;
    const offset = search.type === undefined ? 0 : search.offset ?? 0;

    const q = search.query.trim();
    if (search.resolve && viewerId !== null && isUrlQuery(q)) {
        const found = offset === 0 ? await resolveUrl(ctx, q, viewerId) : undefined;
        if (found === undefined || !wants(found.type)) return nothing;

        return found.type === "accounts"
            ? { ...nothing, accounts: [found.account] }
            : { ...nothing, statuses: [found.note] };
    }

    const accounts = wants("accounts")
        ? await searchAccounts(ctx, {
            query: search.query,
            viewerId,
            resolve: search.resolve,
            following: search.following,
            limit,
            offset,
        })
        : [];
    const statuses = wants("statuses") && viewerId !== null
        ? await searchStatuses(ctx, {
            query: search.query,
            viewerId,
            accountId: search.accountId,
            minId: search.minId,
            maxId: search.maxId,
            limit,
            offset,
        })
        : [];
    const hashtags = wants("hashtags")
        ? await searchHashtags(ctx, { query: search.query, limit, offset })
        : [];

    return { accounts, statuses, hashtags };
};
