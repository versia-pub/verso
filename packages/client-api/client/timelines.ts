import { Status } from "../status.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** Which public statuses to list. */
export type PublicTimelineQuery = PageQuery & {
    /** Only local statuses. Wins over `remote`. */
    readonly local?: boolean;
    /** Only remote statuses. */
    readonly remote?: boolean;
    /** Only statuses with media. */
    readonly only_media?: boolean;
};

/** Which statuses of a hashtag to list. Each list takes at most 4 hashtags, without their `#`. */
export type HashtagTimelineQuery = PublicTimelineQuery & {
    /** Statuses with any of these hashtags too. */
    readonly any?: readonly string[];
    /** Only statuses with all of these hashtags too. */
    readonly all?: readonly string[];
    /** Only statuses with none of these hashtags. */
    readonly none?: readonly string[];
};

/** Lists of statuses, newest first. */
export class TimelineMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's statuses and those of the accounts they follow, and their shares.
     * @see https://docs.joinmastodon.org/methods/timelines/#home
     */
    home(query: PageQuery = {}, options?: CallOptions): Promise<Page<Status>> {
        return Page.get(this.http, Status, "/api/v1/timelines/home", query, options);
    }

    /**
     * Public statuses, local or remote.
     * @see https://docs.joinmastodon.org/methods/timelines/#public
     */
    public(query: PublicTimelineQuery = {}, options?: CallOptions): Promise<Page<Status>> {
        return Page.get(this.http, Status, "/api/v1/timelines/public", query, options);
    }

    /**
     * Public statuses with a hashtag, named without its `#`.
     * @see https://docs.joinmastodon.org/methods/timelines/#tag
     */
    tag(
        hashtag: string,
        query: HashtagTimelineQuery = {},
        options?: CallOptions,
    ): Promise<Page<Status>> {
        return Page.get(this.http, Status, path`/api/v1/timelines/tag/${hashtag}`, query, options);
    }
}
