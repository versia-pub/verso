import { z } from "zod";
import { Account, CredentialAccount, FamiliarFollowers, type Visibility } from "../account.ts";
import { Relationship } from "../relationship.ts";
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

/** Which accounts to search for. Results come by offset, not in linked pages. */
export type AccountSearchQuery = {
    /** A name or username, or a `username@domain` address. */
    readonly q: string;
    readonly limit?: number;
    /** How many results to skip. */
    readonly offset?: number;
    /** Whether to fetch a remote account `q` names exactly, if the instance doesn't know it. */
    readonly resolve?: boolean;
    /** Only accounts the viewer follows. */
    readonly following?: boolean;
};

/** Changes to the viewer's profile and settings. What is omitted stays as it was. */
export type ProfileChanges = {
    readonly display_name?: string;
    /** The bio, in plain text. */
    readonly note?: string;
    /** Whether follow requests wait for approval. */
    readonly locked?: boolean;
    readonly bot?: boolean;
    /** Whether the account may be suggested to others, and listed in the directory. */
    readonly discoverable?: boolean;
    /** Whether its public statuses may appear in search results. */
    readonly indexable?: boolean;
    /** Whether its followers and follows are hidden from others. */
    readonly hide_collections?: boolean;
    readonly avatar?: Blob;
    readonly avatar_description?: string;
    readonly header?: Blob;
    readonly header_description?: string;
    /** Replaces the profile's fields, in order. */
    readonly fields_attributes?: readonly { readonly name: string; readonly value: string }[];
    /** Defaults for the viewer's new statuses. */
    readonly source?: {
        readonly privacy?: Exclude<Visibility, "direct">;
        readonly sensitive?: boolean;
        /** An ISO 639-1 code, such as `en`, or empty for none. */
        readonly language?: string;
    };
};

/** How to follow an account. What is omitted stays as it was, if the viewer already follows it. */
export type FollowOptions = {
    /** Whether its shares show in the home timeline. Defaults to `true`. */
    readonly reblogs?: boolean;
    /** Whether to be notified of its new statuses. Defaults to `false`. */
    readonly notify?: boolean;
    /** Only its statuses in these languages, as ISO 639-1 codes, or all if empty. */
    readonly languages?: readonly string[];
};

/** How to mute an account. */
export type MuteOptions = {
    /** Whether its notifications are muted too. Defaults to `true`. */
    readonly notifications?: boolean;
    /** For how many seconds, or for good if 0, the default. */
    readonly duration?: number;
};

/** Accounts, the viewer's own, and how the viewer is connected to others. */
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
     * Changes the viewer's profile and settings. Sent as a form if it has a picture, and as JSON
     * if not.
     * @see https://docs.joinmastodon.org/methods/accounts/#update_credentials
     */
    updateCredentials(changes: ProfileChanges, options?: CallOptions): Promise<CredentialAccount> {
        const pictures = changes.avatar !== undefined || changes.header !== undefined;

        return this.http.json(CredentialAccount, "PATCH", "/api/v1/accounts/update_credentials", {
            ...options,
            ...pictures ? { form: changes } : { json: changes },
        });
    }

    /**
     * Removes the viewer's avatar, for the default one.
     * @see https://docs.joinmastodon.org/methods/profile/#delete-profile-avatar
     */
    deleteAvatar(options?: CallOptions): Promise<CredentialAccount> {
        return this.http.json(CredentialAccount, "DELETE", "/api/v1/profile/avatar", options);
    }

    /**
     * Removes the viewer's header, for the default one.
     * @see https://docs.joinmastodon.org/methods/profile/#delete-profile-header
     */
    deleteHeader(options?: CallOptions): Promise<CredentialAccount> {
        return this.http.json(CredentialAccount, "DELETE", "/api/v1/profile/header", options);
    }

    /**
     * An account, by its id.
     * @see https://docs.joinmastodon.org/methods/accounts/#get
     */
    get(id: string, options?: CallOptions): Promise<Account> {
        return this.http.json(Account, "GET", path`/api/v1/accounts/${id}`, options);
    }

    /**
     * Several accounts, by their ids, in the same order, without those that don't exist. Mastodon
     * and Verso take at most 40 ids.
     * @see https://docs.joinmastodon.org/methods/accounts/#index
     */
    getMany(ids: readonly string[], options?: CallOptions): Promise<Account[]> {
        return this.http.json(z.array(Account), "GET", "/api/v1/accounts", {
            ...options,
            query: { id: ids },
        });
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
     * Accounts matching a query, best first.
     * @see https://docs.joinmastodon.org/methods/accounts/#search
     */
    search(query: AccountSearchQuery, options?: CallOptions): Promise<Account[]> {
        return this.http.json(z.array(Account), "GET", "/api/v1/accounts/search", {
            ...options,
            query,
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

    /**
     * The accounts following an account, newest first. An account that hides them shows them only
     * to itself.
     * @see https://docs.joinmastodon.org/methods/accounts/#followers
     */
    followers(id: string, query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, path`/api/v1/accounts/${id}/followers`, query, options);
    }

    /**
     * The accounts an account follows, newest first. An account that hides them shows them only to
     * itself.
     * @see https://docs.joinmastodon.org/methods/accounts/#following
     */
    following(id: string, query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, path`/api/v1/accounts/${id}/following`, query, options);
    }

    /**
     * How the viewer is connected to each of some accounts, in the same order.
     * @see https://docs.joinmastodon.org/methods/accounts/#relationships
     */
    relationships(ids: readonly string[], options?: CallOptions): Promise<Relationship[]> {
        return this.http.json(z.array(Relationship), "GET", "/api/v1/accounts/relationships", {
            ...options,
            query: { id: ids },
        });
    }

    /**
     * For each of some accounts, the accounts the viewer follows that follow it.
     * @see https://docs.joinmastodon.org/methods/accounts/#familiar_followers
     */
    familiarFollowers(ids: readonly string[], options?: CallOptions): Promise<FamiliarFollowers[]> {
        return this.http.json(
            z.array(FamiliarFollowers),
            "GET",
            "/api/v1/accounts/familiar_followers",
            { ...options, query: { id: ids } },
        );
    }

    /**
     * Follows an account, or asks to if it approves its followers. Following it again changes the
     * options.
     * @see https://docs.joinmastodon.org/methods/accounts/#follow
     */
    follow(id: string, follow: FollowOptions = {}, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "follow", { ...options, json: follow });
    }

    /**
     * Stops following an account, or withdraws asking to.
     * @see https://docs.joinmastodon.org/methods/accounts/#unfollow
     */
    unfollow(id: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "unfollow", options);
    }

    /**
     * Makes an account stop following the viewer.
     * @see https://docs.joinmastodon.org/methods/accounts/#remove_from_followers
     */
    removeFromFollowers(id: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "remove_from_followers", options);
    }

    /**
     * Blocks an account. Unlike on Mastodon, follows between them stay, and no one is told.
     * @see https://docs.joinmastodon.org/methods/accounts/#block
     */
    block(id: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "block", options);
    }

    /**
     * Unblocks an account.
     * @see https://docs.joinmastodon.org/methods/accounts/#unblock
     */
    unblock(id: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "unblock", options);
    }

    /**
     * Mutes an account, hiding its statuses, and its notifications unless told not to.
     * @see https://docs.joinmastodon.org/methods/accounts/#mute
     */
    mute(id: string, mute: MuteOptions = {}, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "mute", { ...options, json: mute });
    }

    /**
     * Unmutes an account.
     * @see https://docs.joinmastodon.org/methods/accounts/#unmute
     */
    unmute(id: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "unmute", options);
    }

    /**
     * Sets the viewer's private note on an account, or removes it if empty.
     * @see https://docs.joinmastodon.org/methods/accounts/#note
     */
    note(id: string, comment: string, options?: CallOptions): Promise<Relationship> {
        return this.relate(id, "note", { ...options, json: { comment } });
    }

    /** Changes how the viewer is connected to an account, with `action`. */
    private relate(
        id: string,
        action: string,
        options?: CallOptions & { readonly json?: unknown },
    ): Promise<Relationship> {
        return this.http.json(
            Relationship,
            "POST",
            path`/api/v1/accounts/${id}/${action}`,
            options,
        );
    }
}
