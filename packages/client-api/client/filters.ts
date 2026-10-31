import { z } from "zod";
import { Filter, FilterKeyword, FilterStatus } from "../filter.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** A keyword's properties. */
export type KeywordInput = {
    readonly keyword: string;
    /** `true` if left out. */
    readonly whole_word?: boolean;
};

/**
 * A change to one of a filter's keywords: with an `id`, to change that keyword, or remove it with
 * `_destroy`, and without, to add one.
 */
export type KeywordAttributes = Partial<KeywordInput> & {
    readonly id?: string;
    readonly _destroy?: boolean;
};

/** A filter's properties, as a new filter is made with. */
export type FilterInput = {
    readonly title: string;
    readonly context: readonly Filter["context"][number][];
    /** `warn` if left out. */
    readonly filter_action?: Filter["filter_action"];
    /** In how many seconds it expires, or `null` for never, if left out. */
    readonly expires_in?: number | null;
    readonly keywords_attributes?: readonly KeywordAttributes[];
};

/** The viewer's filters, and the keywords and statuses they match. */
export class FilterMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's filters, the oldest first.
     * @see https://docs.joinmastodon.org/methods/filters/#get
     */
    list(options?: CallOptions): Promise<Filter[]> {
        return this.http.json(z.array(Filter), "GET", "/api/v2/filters", options);
    }

    /**
     * One of the viewer's filters.
     * @see https://docs.joinmastodon.org/methods/filters/#get-one
     */
    get(id: string, options?: CallOptions): Promise<Filter> {
        return this.http.json(Filter, "GET", path`/api/v2/filters/${id}`, options);
    }

    /**
     * Makes a filter.
     * @see https://docs.joinmastodon.org/methods/filters/#create
     */
    create(filter: FilterInput, options?: CallOptions): Promise<Filter> {
        return this.http.json(Filter, "POST", "/api/v2/filters", { ...options, json: filter });
    }

    /**
     * Changes a filter, and its keywords as `keywords_attributes` asks. The properties left out
     * stay as they are.
     * @see https://docs.joinmastodon.org/methods/filters/#update
     */
    update(id: string, changes: Partial<FilterInput>, options?: CallOptions): Promise<Filter> {
        return this.http.json(Filter, "PUT", path`/api/v2/filters/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * Deletes a filter.
     * @see https://docs.joinmastodon.org/methods/filters/#delete
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v2/filters/${id}`, options);
    }

    /**
     * A filter's keywords.
     * @see https://docs.joinmastodon.org/methods/filters/#keywords-get
     */
    keywords(filterId: string, options?: CallOptions): Promise<FilterKeyword[]> {
        return this.http.json(
            z.array(FilterKeyword),
            "GET",
            path`/api/v2/filters/${filterId}/keywords`,
            options,
        );
    }

    /**
     * Adds a keyword to a filter.
     * @see https://docs.joinmastodon.org/methods/filters/#keywords-create
     */
    addKeyword(
        filterId: string,
        keyword: KeywordInput,
        options?: CallOptions,
    ): Promise<FilterKeyword> {
        return this.http.json(FilterKeyword, "POST", path`/api/v2/filters/${filterId}/keywords`, {
            ...options,
            json: keyword,
        });
    }

    /**
     * One of the keywords of the viewer's filters.
     * @see https://docs.joinmastodon.org/methods/filters/#keywords-get-one
     */
    keyword(id: string, options?: CallOptions): Promise<FilterKeyword> {
        return this.http.json(FilterKeyword, "GET", path`/api/v2/filters/keywords/${id}`, options);
    }

    /**
     * Changes a keyword. The properties left out stay as they are.
     * @see https://docs.joinmastodon.org/methods/filters/#keywords-update
     */
    updateKeyword(
        id: string,
        changes: Partial<KeywordInput>,
        options?: CallOptions,
    ): Promise<FilterKeyword> {
        return this.http.json(FilterKeyword, "PUT", path`/api/v2/filters/keywords/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * Removes a keyword from its filter.
     * @see https://docs.joinmastodon.org/methods/filters/#keywords-delete
     */
    async removeKeyword(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v2/filters/keywords/${id}`, options);
    }

    /**
     * The statuses a filter matches.
     * @see https://docs.joinmastodon.org/methods/filters/#statuses-get
     */
    statuses(filterId: string, options?: CallOptions): Promise<FilterStatus[]> {
        return this.http.json(
            z.array(FilterStatus),
            "GET",
            path`/api/v2/filters/${filterId}/statuses`,
            options,
        );
    }

    /**
     * Adds a status the viewer can see to a filter.
     * @see https://docs.joinmastodon.org/methods/filters/#statuses-add
     */
    addStatus(filterId: string, statusId: string, options?: CallOptions): Promise<FilterStatus> {
        return this.http.json(FilterStatus, "POST", path`/api/v2/filters/${filterId}/statuses`, {
            ...options,
            json: { status_id: statusId },
        });
    }

    /**
     * One of the statuses of the viewer's filters, by its filter status's id.
     * @see https://docs.joinmastodon.org/methods/filters/#statuses-get-one
     */
    status(id: string, options?: CallOptions): Promise<FilterStatus> {
        return this.http.json(FilterStatus, "GET", path`/api/v2/filters/statuses/${id}`, options);
    }

    /**
     * Removes a status from its filter, by its filter status's id.
     * @see https://docs.joinmastodon.org/methods/filters/#statuses-remove
     */
    async removeStatus(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v2/filters/statuses/${id}`, options);
    }
}
