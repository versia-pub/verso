import { z } from "zod";
import { Account, MutedAccount } from "../account.ts";
import { Relationship } from "../relationship.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** The accounts asking to follow the viewer. */
export class FollowRequestMethods {
    constructor(private readonly http: Http) {}

    /**
     * The accounts asking to follow the viewer, newest first.
     * @see https://docs.joinmastodon.org/methods/follow_requests/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, "/api/v1/follow_requests", query, options);
    }

    /**
     * Accepts an account's request to follow the viewer.
     * @see https://docs.joinmastodon.org/methods/follow_requests/#accept
     */
    authorize(id: string, options?: CallOptions): Promise<Relationship> {
        return this.http.json(
            Relationship,
            "POST",
            path`/api/v1/follow_requests/${id}/authorize`,
            options,
        );
    }

    /**
     * Rejects an account's request to follow the viewer.
     * @see https://docs.joinmastodon.org/methods/follow_requests/#reject
     */
    reject(id: string, options?: CallOptions): Promise<Relationship> {
        return this.http.json(
            Relationship,
            "POST",
            path`/api/v1/follow_requests/${id}/reject`,
            options,
        );
    }
}

/** The accounts the viewer blocks. Block and unblock them with `accounts`. */
export class BlockMethods {
    constructor(private readonly http: Http) {}

    /**
     * The accounts the viewer blocks.
     * @see https://docs.joinmastodon.org/methods/blocks/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, "/api/v1/blocks", query, options);
    }
}

/** The accounts the viewer features on their profile. Feature them with `accounts`. */
export class EndorsementMethods {
    constructor(private readonly http: Http) {}

    /**
     * The accounts the viewer features, the latest featured first.
     * @see https://docs.joinmastodon.org/methods/endorsements/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, "/api/v1/endorsements", query, options);
    }
}

/** The accounts the viewer mutes. Mute and unmute them with `accounts`. */
export class MuteMethods {
    constructor(private readonly http: Http) {}

    /**
     * The accounts the viewer mutes, with when each mute ends.
     * @see https://docs.joinmastodon.org/methods/mutes/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<MutedAccount>> {
        return Page.get(this.http, MutedAccount, "/api/v1/mutes", query, options);
    }
}

/** The domains the viewer blocks, which blocks each of their accounts. */
export class DomainBlockMethods {
    constructor(private readonly http: Http) {}

    /**
     * The domains the viewer blocks.
     * @see https://docs.joinmastodon.org/methods/domain_blocks/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<string>> {
        return Page.get(this.http, z.string(), "/api/v1/domain_blocks", query, options);
    }

    /**
     * Blocks a domain and its subdomains. Unlike on Mastodon, follows stay, and no one is told.
     * @see https://docs.joinmastodon.org/methods/domain_blocks/#block
     */
    async block(domain: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", "/api/v1/domain_blocks", { ...options, json: { domain } });
    }

    /**
     * Unblocks a domain.
     * @see https://docs.joinmastodon.org/methods/domain_blocks/#unblock
     */
    async unblock(domain: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", "/api/v1/domain_blocks", { ...options, json: { domain } });
    }
}
