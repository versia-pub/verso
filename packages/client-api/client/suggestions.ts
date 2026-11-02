import { z } from "zod";
import { Suggestion } from "../suggestion.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** Which accounts of the suggestions to fetch. */
export type SuggestionQuery = {
    /** How many to skip. */
    readonly offset?: number;
    /** The most to return. Instances give at most 80. */
    readonly limit?: number;
};

/** The accounts suggested to the viewer to follow. */
export class SuggestionMethods {
    constructor(private readonly http: Http) {}

    /**
     * The accounts suggested to follow, with why.
     * @see https://docs.joinmastodon.org/methods/suggestions/#v2
     */
    list(query?: SuggestionQuery, options?: CallOptions): Promise<Suggestion[]> {
        return this.http.json(z.array(Suggestion), "GET", "/api/v2/suggestions", {
            ...options,
            query,
        });
    }

    /**
     * Stops suggesting an account.
     * @see https://docs.joinmastodon.org/methods/suggestions/#remove
     */
    async dismiss(accountId: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/suggestions/${accountId}`, options);
    }
}
