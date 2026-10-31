import { z } from "zod";
import { FeaturedTag, Tag } from "../tag.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

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

/** Hashtags, and following them. */
export class TagMethods {
    constructor(private readonly http: Http) {}

    /**
     * The hashtag `name`, given without its `#`, with how it was used lately.
     * @see https://docs.joinmastodon.org/methods/tags/#get
     */
    get(name: string, options?: CallOptions): Promise<Tag> {
        return this.http.json(Tag, "GET", path`/api/v1/tags/${name}`, options);
    }

    /**
     * Follows the hashtag `name`, putting its public statuses on the viewer's home timeline.
     * @see https://docs.joinmastodon.org/methods/tags/#follow
     */
    follow(name: string, options?: CallOptions): Promise<Tag> {
        return this.http.json(Tag, "POST", path`/api/v1/tags/${name}/follow`, options);
    }

    /**
     * Stops following the hashtag `name`.
     * @see https://docs.joinmastodon.org/methods/tags/#unfollow
     */
    unfollow(name: string, options?: CallOptions): Promise<Tag> {
        return this.http.json(Tag, "POST", path`/api/v1/tags/${name}/unfollow`, options);
    }
}

/** The hashtags the viewer follows. */
export class FollowedTagMethods {
    constructor(private readonly http: Http) {}

    /**
     * The hashtags the viewer follows, the latest followed first.
     * @see https://docs.joinmastodon.org/methods/followed_tags/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Tag>> {
        return Page.get(this.http, Tag, "/api/v1/followed_tags", query, options);
    }
}
