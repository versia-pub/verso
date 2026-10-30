/**
 * A client for a Verso instance's client API, which checks every response against this package's
 * schemas.
 * @example
 * const client = new Client("https://verso.example", { token });
 * const me = await client.accounts.verifyCredentials();
 * for await (const status of await client.accounts.statuses(me.id)) console.log(status.content);
 * @module
 */
import type { Search } from "./search.ts";
import { AccountMethods } from "./client/accounts.ts";
import { EmojiMethods } from "./client/emojis.ts";
import {
    BlockMethods,
    DomainBlockMethods,
    FollowRequestMethods,
    MuteMethods,
} from "./client/graph.ts";
import { type CallOptions, Http, type RateLimit } from "./client/http.ts";
import { InstanceMethods } from "./client/instance.ts";
import { MediaMethods } from "./client/media.ts";
import {
    GroupedNotificationMethods,
    MarkerMethods,
    NotificationMethods,
} from "./client/notifications.ts";
import { OAuth } from "./client/oauth.ts";
import { PushMethods } from "./client/push.ts";
import { RoleMethods } from "./client/roles.ts";
import { search, type SearchQuery } from "./client/search.ts";
import { StreamingMethods } from "./client/streaming.ts";
import { BookmarkMethods, FavouriteMethods, StatusMethods } from "./client/statuses.ts";
import { TimelineMethods } from "./client/timelines.ts";

export type {
    AccountSearchQuery,
    AccountStatusesQuery,
    DirectoryQuery,
    FollowOptions,
    MuteOptions,
    ProfileChanges,
} from "./client/accounts.ts";
export type { EmojiChanges, EmojiDraft } from "./client/emojis.ts";
export { ApiError, type CallOptions, type RateLimit, UnexpectedResponse } from "./client/http.ts";
export type { Upload } from "./client/media.ts";
export type {
    GroupedNotificationsQuery,
    Grouping,
    MarkerChanges,
    MarkerTimeline,
    NotificationFilter,
    NotificationsQuery,
    UnreadCountQuery,
} from "./client/notifications.ts";
export {
    type AppCredentials,
    type AppRegistration,
    type Authorization,
    createPkce,
    outOfBand,
    type Pkce,
} from "./client/oauth.ts";
export { Page, type PageQuery } from "./client/pages.ts";
export type { PushData, PushEndpoint } from "./client/push.ts";
export type { RoleChanges, RoleDraft } from "./client/roles.ts";
export type { SearchQuery } from "./client/search.ts";
export type { ContentType, ReblogOptions, StatusChanges, StatusDraft } from "./client/statuses.ts";
export {
    type Closed,
    type ConnectOptions,
    Stream,
    type StreamEvent,
    type StreamName,
    type Subscription,
} from "./client/streaming.ts";
export type { HashtagTimelineQuery, PublicTimelineQuery } from "./client/timelines.ts";

export type ClientOptions = {
    /** The user's or app's access token. Without one, requests are made as nobody. */
    readonly token?: string;
    /** Sends each request. Defaults to the global `fetch`. */
    readonly fetch?: typeof globalThis.fetch;
};

/** Calls one instance's client API, as one user or app, or as nobody. */
export class Client {
    readonly #http: Http;
    readonly #fetch: typeof globalThis.fetch;

    /** Registering apps, and logging users in to them. */
    readonly oauth: OAuth;
    /** What the instance says about itself. */
    readonly instance: InstanceMethods;
    /** Accounts, the viewer's own, and how the viewer is connected to others. */
    readonly accounts: AccountMethods;
    /** The accounts asking to follow the viewer. */
    readonly followRequests: FollowRequestMethods;
    /** The accounts the viewer blocks. */
    readonly blocks: BlockMethods;
    /** The accounts the viewer mutes. */
    readonly mutes: MuteMethods;
    /** The domains the viewer blocks. */
    readonly domainBlocks: DomainBlockMethods;
    /** Posting, viewing, editing and deleting statuses, and liking, sharing, reacting to and bookmarking them. */
    readonly statuses: StatusMethods;
    /** The statuses the viewer likes. */
    readonly favourites: FavouriteMethods;
    /** The statuses the viewer bookmarked. */
    readonly bookmarks: BookmarkMethods;
    /** Lists of statuses, newest first. */
    readonly timelines: TimelineMethods;
    /** The viewer's notifications, each on its own. */
    readonly notifications: NotificationMethods;
    /** The viewer's notifications in groups, such as the likes of a status. */
    readonly groupedNotifications: GroupedNotificationMethods;
    /** Where the viewer last read up to in their home timeline and notifications. */
    readonly markers: MarkerMethods;
    /** Events as they happen, over a WebSocket. */
    readonly streaming: StreamingMethods;
    /** Pushing the notifications of the viewer's token to a browser. */
    readonly push: PushMethods;
    /** The instance's custom emojis, and the viewer's own. */
    readonly emojis: EmojiMethods;
    /** Roles, which grant permissions to the accounts that have them. */
    readonly roles: RoleMethods;
    /** Uploading files to attach to statuses. */
    readonly media: MediaMethods;

    /** A client for the instance at `url`, such as `https://verso.example`. */
    constructor(url: string | URL, options: ClientOptions = {}) {
        this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.#http = new Http(new URL(url), options.token, this.#fetch);

        this.oauth = new OAuth(this.#http);
        this.instance = new InstanceMethods(this.#http);
        this.accounts = new AccountMethods(this.#http);
        this.followRequests = new FollowRequestMethods(this.#http);
        this.blocks = new BlockMethods(this.#http);
        this.mutes = new MuteMethods(this.#http);
        this.domainBlocks = new DomainBlockMethods(this.#http);
        this.statuses = new StatusMethods(this.#http);
        this.favourites = new FavouriteMethods(this.#http);
        this.bookmarks = new BookmarkMethods(this.#http);
        this.timelines = new TimelineMethods(this.#http);
        this.notifications = new NotificationMethods(this.#http);
        this.groupedNotifications = new GroupedNotificationMethods(this.#http);
        this.markers = new MarkerMethods(this.#http);
        this.streaming = new StreamingMethods(this.#http);
        this.push = new PushMethods(this.#http);
        this.emojis = new EmojiMethods(this.#http);
        this.roles = new RoleMethods(this.#http);
        this.media = new MediaMethods(this.#http);
    }

    /** The instance's URL. */
    get url(): URL {
        return new URL(this.#http.url);
    }

    /** The access token requests are made with, if any. */
    get token(): string | undefined {
        return this.#http.token;
    }

    /** The rate limit the latest response gave, or `undefined` before one has. */
    get rateLimit(): RateLimit | undefined {
        return this.#http.rateLimit;
    }

    /**
     * Accounts, statuses and hashtags matching a query. Only a signed-in user finds statuses, and
     * only for a query with a word, a phrase, a hashtag, `from:` or `in:library`, or with
     * `account_id`.
     * @see https://docs.joinmastodon.org/methods/search/#v2
     */
    search(query: SearchQuery, options?: CallOptions): Promise<Search> {
        return search(this.#http, query, options);
    }

    /** A client for the same instance, making requests with `token`, such as one just issued. */
    withToken(token: string): Client {
        return new Client(this.#http.url, { token, fetch: this.#fetch });
    }
}
