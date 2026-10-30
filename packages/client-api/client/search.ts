import { Search } from "../search.ts";
import type { CallOptions, Http } from "./http.ts";

/** What to search for. Results come by offset, not in linked pages. */
export type SearchQuery = {
    readonly q: string;
    /** Only this kind of result. */
    readonly type?: "accounts" | "hashtags" | "statuses";
    /**
     * Whether to fetch the remote account `q` addresses, or the remote account or status at the URL
     * `q` is, if the instance doesn't know it. Only for a signed-in user.
     */
    readonly resolve?: boolean;
    /** Only accounts the viewer follows. */
    readonly following?: boolean;
    /** Only statuses by this account. */
    readonly account_id?: string;
    /** Only results older than this id. */
    readonly max_id?: string;
    /** Only results newer than this id. */
    readonly min_id?: string;
    /** At most this many of each kind. */
    readonly limit?: number;
    /** How many results to skip, when `type` is given. Only for a signed-in user. */
    readonly offset?: number;
};

/** Searches with `http`, as `Client.search` describes. */
export const search = (http: Http, query: SearchQuery, options?: CallOptions): Promise<Search> =>
    http.json(Search, "GET", "/api/v2/search", { ...options, query });
