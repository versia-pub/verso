import { z } from "zod";
import { TrendsLink } from "../preview_card.ts";
import { Status } from "../status.ts";
import { Tag } from "../tag.ts";
import type { CallOptions, Http } from "./http.ts";

/** Which of a trending list to fetch. */
export type TrendQuery = {
    /** How many to skip. */
    readonly offset?: number;
    /** The most to return. Instances give at most 20 hashtags or links, or 40 statuses. */
    readonly limit?: number;
};

/** What is trending on the instance, if it shows that. */
export class TrendMethods {
    constructor(private readonly http: Http) {}

    /**
     * The hashtags used by more accounts than usual lately, the highest scoring first.
     * @see https://docs.joinmastodon.org/methods/trends/#tags
     */
    tags(query?: TrendQuery, options?: CallOptions): Promise<Tag[]> {
        return this.http.json(z.array(Tag), "GET", "/api/v1/trends/tags", { ...options, query });
    }

    /**
     * The statuses liked and boosted more than others lately, the highest scoring first.
     * @see https://docs.joinmastodon.org/methods/trends/#statuses
     */
    statuses(query?: TrendQuery, options?: CallOptions): Promise<Status[]> {
        return this.http.json(z.array(Status), "GET", "/api/v1/trends/statuses", {
            ...options,
            query,
        });
    }

    /**
     * The links shared by more accounts than usual lately, the highest scoring first.
     * @see https://docs.joinmastodon.org/methods/trends/#links
     */
    links(query?: TrendQuery, options?: CallOptions): Promise<TrendsLink[]> {
        return this.http.json(z.array(TrendsLink), "GET", "/api/v1/trends/links", {
            ...options,
            query,
        });
    }
}
