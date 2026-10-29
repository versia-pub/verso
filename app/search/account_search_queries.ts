/**
 * Searching accounts. Besides the index, its queries read the accounts table, and the viewer's
 * follows through the graph's query helpers, so that a search takes one query.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { followedIdsQuery, followerIdsQuery } from "../graph/follow_queries.ts";
import { accountIndex, matching } from "./index_queries.ts";

/** What accounts to find, besides their words. */
export type AccountMatch = {
    /** Who is searching, if anyone is signed in. */
    readonly viewerId: string | null;
    /** Whether to find only the viewer and the accounts they follow. */
    readonly following: boolean;
    readonly limit: number;
    readonly offset: number;
};

/**
 * Accounts with words that start with each of `words`, as Mastodon orders them: those the viewer
 * follows or is followed by first, then those with the most followers. No words find nothing.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/concerns/account/search.rb
 */
export const accountIdsMatching = async (
    ctx: Context,
    words: readonly string[],
    match: AccountMatch,
): Promise<string[]> => {
    const { viewerId } = match;
    if (words.length === 0) return [];

    let query = ctx.db.selectFrom("accounts")
        .select("accounts.id")
        .where(matching(ctx, accountIndex, "accounts.id", words));
    if (viewerId !== null) {
        const followed = followedIdsQuery(ctx, viewerId);
        if (match.following) {
            query = query.where((eb) =>
                eb.or([eb("accounts.id", "=", viewerId), eb("accounts.id", "in", followed)])
            );
        }

        // 1 for each way the viewer and the account follow each other. The sets are each looked up
        // once, rather than counted again for every account that matches.
        const following = followerIdsQuery(ctx, viewerId);
        query = query.orderBy(
            (eb) =>
                eb(
                    eb.case().when("accounts.id", "in", followed).then(1).else(0).end(),
                    "+",
                    eb.case().when("accounts.id", "in", following).then(1).else(0).end(),
                ),
            "desc",
        );
    }

    const rows = await query
        .orderBy("accounts.followers_count", "desc")
        .orderBy("accounts.id")
        .limit(match.limit)
        .offset(match.offset)
        .execute();

    return rows.map((row) => row.id);
};
