/**
 * A client for a Verso instance's client API, which checks every response against this package's
 * schemas.
 * @example
 * const client = new Client("https://verso.example", { token });
 * const me = await client.accounts.verifyCredentials();
 * for await (const status of await client.accounts.statuses(me.id)) console.log(status.content);
 * @module
 */
import { AccountMethods } from "./client/accounts.ts";
import { Http, type RateLimit } from "./client/http.ts";
import { InstanceMethods } from "./client/instance.ts";
import { MediaMethods } from "./client/media.ts";
import { OAuth } from "./client/oauth.ts";
import { StatusMethods } from "./client/statuses.ts";

export type { AccountStatusesQuery } from "./client/accounts.ts";
export { ApiError, type CallOptions, type RateLimit, UnexpectedResponse } from "./client/http.ts";
export type { Upload } from "./client/media.ts";
export {
    type AppCredentials,
    type AppRegistration,
    type Authorization,
    createPkce,
    outOfBand,
    type Pkce,
} from "./client/oauth.ts";
export { Page, type PageQuery } from "./client/pages.ts";
export type { ContentType, StatusChanges, StatusDraft } from "./client/statuses.ts";

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
    /** Accounts, and the viewer's own. */
    readonly accounts: AccountMethods;
    /** Posting, viewing, editing and deleting statuses. */
    readonly statuses: StatusMethods;
    /** Uploading files to attach to statuses. */
    readonly media: MediaMethods;

    /** A client for the instance at `url`, such as `https://verso.example`. */
    constructor(url: string | URL, options: ClientOptions = {}) {
        this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.#http = new Http(new URL(url), options.token, this.#fetch);

        this.oauth = new OAuth(this.#http);
        this.instance = new InstanceMethods(this.#http);
        this.accounts = new AccountMethods(this.#http);
        this.statuses = new StatusMethods(this.#http);
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

    /** A client for the same instance, making requests with `token`, such as one just issued. */
    withToken(token: string): Client {
        return new Client(this.#http.url, { token, fetch: this.#fetch });
    }
}
