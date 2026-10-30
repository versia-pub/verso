import { z } from "zod";
import { FeaturedTag, Tag } from "../tag.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** The hashtags the viewer features on their profile. */
export class FeaturedTagMethods {
    constructor(private readonly http: Http) {}

    /**
     * The hashtags the viewer features, the most used first.
     * @see https://docs.joinmastodon.org/methods/featured_tags/#get
     */
    list(options?: CallOptions): Promise<FeaturedTag[]> {
        return this.http.json(z.array(FeaturedTag), "GET", "/api/v1/featured_tags", options);
    }

    /**
     * Features a hashtag, given without its `#`, or returns it if the viewer already features it.
     * @see https://docs.joinmastodon.org/methods/featured_tags/#feature
     */
    feature(name: string, options?: CallOptions): Promise<FeaturedTag> {
        return this.http.json(FeaturedTag, "POST", "/api/v1/featured_tags", {
            ...options,
            json: { name },
        });
    }

    /**
     * Stops featuring a hashtag, by its featured hashtag's id.
     * @see https://docs.joinmastodon.org/methods/featured_tags/#unfeature
     */
    async unfeature(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/featured_tags/${id}`, options);
    }

    /**
     * Hashtags the viewer used lately and doesn't feature, the most used first.
     * @see https://docs.joinmastodon.org/methods/featured_tags/#suggestions
     */
    suggestions(options?: CallOptions): Promise<Tag[]> {
        return this.http.json(z.array(Tag), "GET", "/api/v1/featured_tags/suggestions", options);
    }
}
