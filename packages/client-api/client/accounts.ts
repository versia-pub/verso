import { Account, CredentialAccount } from "../account.ts";
import { Status } from "../status.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** Which of an account's statuses to list. */
export type AccountStatusesQuery = PageQuery & {
    readonly exclude_replies?: boolean;
    readonly exclude_reblogs?: boolean;
    readonly only_media?: boolean;
    /** Only those pinned to the profile. */
    readonly pinned?: boolean;
    /** Only those with this hashtag, without the `#`. */
    readonly tagged?: string;
};

/** Accounts, and the viewer's own. */
export class AccountMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's own account, with their settings.
     * @see https://docs.joinmastodon.org/methods/accounts/#verify_credentials
     */
    verifyCredentials(options?: CallOptions): Promise<CredentialAccount> {
        return this.http.json(
            CredentialAccount,
            "GET",
            "/api/v1/accounts/verify_credentials",
            options,
        );
    }

    /**
     * An account, by its id.
     * @see https://docs.joinmastodon.org/methods/accounts/#get
     */
    get(id: string, options?: CallOptions): Promise<Account> {
        return this.http.json(Account, "GET", path`/api/v1/accounts/${id}`, options);
    }

    /**
     * An account, by its username, or `username@domain` for a remote one, which the instance may
     * fetch.
     * @see https://docs.joinmastodon.org/methods/accounts/#lookup
     */
    lookup(acct: string, options?: CallOptions): Promise<Account> {
        return this.http.json(Account, "GET", "/api/v1/accounts/lookup", {
            ...options,
            query: { acct },
        });
    }

    /**
     * An account's statuses that the viewer may see, newest first.
     * @see https://docs.joinmastodon.org/methods/accounts/#statuses
     */
    statuses(
        id: string,
        query: AccountStatusesQuery = {},
        options?: CallOptions,
    ): Promise<Page<Status>> {
        return Page.get(this.http, Status, path`/api/v1/accounts/${id}/statuses`, query, options);
    }
}
