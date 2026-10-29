/**
 * Finding accounts, local and remote, by their address, or by the start of the words of their
 * names and domain, as Mastodon does.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/account_search_service.rb
 * @module
 */
import { type AccountRow, findAccounts } from "../accounts/account_queries.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { isAccountCreated, isAccountReceived, isProfileUpdated } from "../accounts/events.ts";
import { isFollowing } from "../graph/follows.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { accountIdsMatching } from "./account_search_queries.ts";
import { indexAccount, unindexedAccountIds } from "./index_queries.ts";
import { searchWords } from "./words.ts";

/** Indexes the words of each of `accountIds`: its username, display name and domain. */
const indexAccounts = async (ctx: Pick<Context, "db">, accountIds: readonly string[]) => {
    for (const account of await findAccounts(ctx, accountIds)) {
        const text = [account.username, account.display_name, account.domain ?? ""].join(" ");
        await indexAccount(ctx, account.id, searchWords(text));
    }
};

/** Indexes accounts as they are created, changed or received. */
export const indexAccountsOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountCreated(event) || isProfileUpdated(event) || isAccountReceived(event)) {
        await indexAccounts(ctx, [event.accountId]);
    }
};

/** How many accounts are indexed at a time. */
const batchSize = 500;

/**
 * Indexes the accounts that aren't yet, such as those from before Verso searched them, and returns
 * how many there were.
 */
export const indexUnindexedAccounts = async (ctx: Pick<Context, "db">): Promise<number> => {
    let count = 0;
    let after = null;
    for (;;) {
        const accountIds = await unindexedAccountIds(ctx, after, batchSize);
        if (accountIds.length === 0) return count;

        await indexAccounts(ctx, accountIds);
        count += accountIds.length;
        after = accountIds[accountIds.length - 1];
    }
};

/** A search for accounts. */
export type AccountSearch = {
    /** An address, or words. */
    readonly query: string;
    /** Who is searching, if anyone is signed in. */
    readonly viewerId: string | null;
    /** Whether to look up a remote account by its address, if Verso doesn't have it. */
    readonly resolve: boolean;
    /** Whether to find only the viewer and the accounts they follow. */
    readonly following: boolean;
    readonly limit: number;
    readonly offset: number;
};

/** How long a query must be to find accounts by their words without signing in, as on Mastodon. */
const minAnonymousLength = 5;

/**
 * The account at the address `query` names, if it names one with its domain, and the viewer
 * follows it when only those are wanted, as on Mastodon. Only the first page has it.
 */
const exactMatch = async (ctx: Context, search: AccountSearch) => {
    if (search.offset > 0 || !search.query.includes("@")) return undefined;

    const address = parseAddress(ctx, search.query);
    const account = address && await findAccountByAddress(ctx, address, { fetch: search.resolve });
    if (account === undefined || !search.following || search.viewerId === null) return account;

    return await isFollowing(ctx, search.viewerId, account.id) ? account : undefined;
};

/**
 * The accounts `search` finds, as Mastodon does: the account at the address it names, then those
 * whose words start with each of its words. A local address is searched as its username. Without
 * signing in, a short query only finds the account at its address.
 */
export const searchAccounts = async (
    ctx: Context,
    search: AccountSearch,
): Promise<AccountRow[]> => {
    const query = search.query.trim().replace(/^@/, "");
    const exact = await exactMatch(ctx, { ...search, query });
    if (search.viewerId === null && query.length < minAnonymousLength) return exact ? [exact] : [];

    const address = parseAddress(ctx, query);
    const words = searchWords(address?.domain === null ? address.username : query);
    const ids = await accountIdsMatching(ctx, words, search);
    const found = new Map((await findAccounts(ctx, ids)).map((account) => [account.id, account]));
    const matches = ids.flatMap((id) => {
        const account = found.get(id);
        return account && id !== exact?.id ? [account] : [];
    });

    return [...exact ? [exact] : [], ...matches].slice(0, search.limit);
};
