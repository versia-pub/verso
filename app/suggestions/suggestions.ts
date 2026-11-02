/**
 * The accounts suggested to a user to follow: those an admin picked, then those followed by the
 * accounts they follow. Mastodon has two more sources, which Verso leaves out: the accounts that
 * most recent users followed or interacted with, and the ones that are alike to those they just
 * followed, which needs Elasticsearch.
 * @module
 */
import type { SuggestionSource } from "@versia/client-api";
import { findAccount } from "../accounts/account_queries.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import type { Context } from "../kernel/context.ts";
import { friendsOfFriends, insertDismissal, suggestibleAmong } from "./suggestion_queries.ts";

/** How many accounts each source gives, as on Mastodon, however many are asked for. */
const sourceLimit = 40;

/** An account that is suggested, and why. */
export type Suggested = {
    readonly accountId: string;
    readonly sources: readonly SuggestionSource[];
};

/** The ids of the accounts at `addresses` that Verso knows, in order, without repeats. */
const featuredIds = async (ctx: Context, addresses: readonly string[]): Promise<string[]> => {
    const ids = new Set<string>();

    for (const text of addresses) {
        const address = parseAddress(ctx, text);
        if (address === undefined) continue;

        const account = await findAccountByAddress(ctx, address, { fetch: false });
        if (account !== undefined) ids.add(account.id);
    }

    return [...ids];
};

/**
 * The accounts to suggest to `viewerId`, from `offset`: the ones in `featured` first, then the
 * friends of friends, each with the sources that gave it. The same accounts come in the same order
 * until the accounts or follows change.
 */
export const suggestionsFor = async (
    ctx: Context,
    viewerId: string,
    featured: readonly string[],
    page: { readonly offset: number; readonly limit: number },
): Promise<Suggested[]> => {
    const sources = new Map<string, SuggestionSource[]>();
    const add = (ids: readonly string[], source: SuggestionSource) => {
        for (const id of ids) sources.set(id, [...sources.get(id) ?? [], source]);
    };

    add(
        (await suggestibleAmong(ctx, viewerId, await featuredIds(ctx, featured)))
            .slice(0, sourceLimit),
        "featured",
    );
    add(await friendsOfFriends(ctx, viewerId, sourceLimit), "friends_of_friends");

    return [...sources].slice(page.offset, page.offset + page.limit)
        .map(([accountId, accountSources]) => ({ accountId, sources: accountSources }));
};

/**
 * Stops suggesting `targetId` to `accountId`. Nothing happens if there is no such account, which
 * Mastodon doesn't tell either.
 */
export const dismissSuggestion = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<void> => {
    if (await findAccount(ctx, targetId) !== undefined) {
        await insertDismissal(ctx, accountId, targetId);
    }
};
