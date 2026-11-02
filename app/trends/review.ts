/**
 * Admins approving or rejecting what trends, since Verso has no admin API to do it through.
 * @module
 */
import { canonicalizeDomain } from "@versia/protocol";
import { findLocalAccount, findRemoteAccountByName } from "../accounts/account_queries.ts";
import { findInstanceId } from "../instances/instance_queries.ts";
import type { Context } from "../kernel/context.ts";
import {
    setAccountTrendable,
    setTagTrendable,
    trendingAccountsForAdmin,
    trendingTagsForAdmin,
} from "./trend_queries.ts";

/**
 * Whether something trends: an admin approved or rejected it, or hasn't decided and the instance's
 * default, `byDefault`, applies, which is pending approval if it doesn't approve.
 */
export type TrendState = "approved" | "rejected" | "pending";

const stateOf = (trendable: boolean | null, byDefault: boolean): TrendState => {
    if (trendable === null) return byDefault ? "approved" : "pending";
    return trendable ? "approved" : "rejected";
};

/** What is trending, with whether each is shown. */
export type TrendsForAdmin = {
    readonly tags: readonly { name: string; score: number; state: TrendState }[];
    readonly accounts: readonly { id: string; acct: string; score: number; state: TrendState }[];
};

/** What is trending, with whether it is shown, for an admin to review. */
export const trendsForAdmin = async (
    ctx: Context,
    byDefault: boolean,
): Promise<TrendsForAdmin> => ({
    tags: (await trendingTagsForAdmin(ctx)).map((tag) => ({
        name: tag.name,
        score: tag.score,
        state: stateOf(tag.trendable, byDefault),
    })),
    accounts: (await trendingAccountsForAdmin(ctx)).map((account) => ({
        id: account.id,
        acct: account.domain === null ? account.username : `${account.username}@${account.domain}`,
        score: account.score,
        state: stateOf(account.trendable, byDefault),
    })),
});

/**
 * Lets the hashtag `name`, with or without its `#`, trend or not. Returns `false` if no status has
 * used it.
 */
export const decideTag = (ctx: Context, name: string, trendable: boolean): Promise<boolean> =>
    setTagTrendable(ctx, name.replace(/^#/, ""), trendable);

/**
 * Lets the statuses of the account `acct`, a local username or `username@domain`, trend or not.
 * Returns its id, or `undefined` if Verso doesn't have it.
 */
export const decideAccount = async (
    ctx: Context,
    acct: string,
    trendable: boolean,
): Promise<string | undefined> => {
    const [username = "", domain, ...rest] = acct.replace(/^@/, "").split("@");
    if (username === "" || rest.length > 0) return undefined;

    let account;
    if (domain === undefined) {
        account = await findLocalAccount(ctx, username);
    } else {
        const instanceId = await findInstanceId(ctx, canonicalizeDomain(domain) ?? domain);
        account = instanceId === undefined
            ? undefined
            : await findRemoteAccountByName(ctx, username, instanceId);
    }

    if (account === undefined) return undefined;

    await setAccountTrendable(ctx, account.id, trendable);
    return account.id;
};
