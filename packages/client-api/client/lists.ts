import { z } from "zod";
import { Account } from "../account.ts";
import { List } from "../list.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** A list's properties, as a new list is made with. */
export type ListInput = {
    readonly title: string;
    /** `list` if left out. */
    readonly replies_policy?: List["replies_policy"];
    /** `false` if left out. */
    readonly exclusive?: boolean;
};

/** The viewer's lists of accounts. */
export class ListMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's lists.
     * @see https://docs.joinmastodon.org/methods/lists/#get
     */
    list(options?: CallOptions): Promise<List[]> {
        return this.http.json(z.array(List), "GET", "/api/v1/lists", options);
    }

    /**
     * One of the viewer's lists.
     * @see https://docs.joinmastodon.org/methods/lists/#get-one
     */
    get(id: string, options?: CallOptions): Promise<List> {
        return this.http.json(List, "GET", path`/api/v1/lists/${id}`, options);
    }

    /**
     * Makes a list.
     * @see https://docs.joinmastodon.org/methods/lists/#create
     */
    create(list: ListInput, options?: CallOptions): Promise<List> {
        return this.http.json(List, "POST", "/api/v1/lists", { ...options, json: list });
    }

    /**
     * Changes a list. The properties left out stay as they are.
     * @see https://docs.joinmastodon.org/methods/lists/#update
     */
    update(id: string, changes: Partial<ListInput>, options?: CallOptions): Promise<List> {
        return this.http.json(List, "PUT", path`/api/v1/lists/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * Deletes a list.
     * @see https://docs.joinmastodon.org/methods/lists/#delete
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/lists/${id}`, options);
    }

    /**
     * The accounts in a list, the latest added first. A `limit` of 0 gets them all in one page.
     * @see https://docs.joinmastodon.org/methods/lists/#accounts
     */
    accounts(id: string, query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(this.http, Account, path`/api/v1/lists/${id}/accounts`, query, options);
    }

    /**
     * Adds accounts the viewer follows, or has asked to follow, to a list: all of them, or none if
     * any can't be added.
     * @see https://docs.joinmastodon.org/methods/lists/#accounts-add
     */
    async addAccounts(
        id: string,
        accountIds: readonly string[],
        options?: CallOptions,
    ): Promise<void> {
        await this.http.send("POST", path`/api/v1/lists/${id}/accounts`, {
            ...options,
            json: { account_ids: accountIds },
        });
    }

    /**
     * Removes accounts from a list.
     * @see https://docs.joinmastodon.org/methods/lists/#accounts-remove
     */
    async removeAccounts(
        id: string,
        accountIds: readonly string[],
        options?: CallOptions,
    ): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/lists/${id}/accounts`, {
            ...options,
            json: { account_ids: accountIds },
        });
    }
}
