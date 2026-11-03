/**
 * Admins approving or rejecting what trends, since Verso has no admin API to do it through.
 * @module
 */
import { canonicalizeDomain } from "@versia/protocol";
import { findLocalAccount, findRemoteAccountByName } from "../accounts/account_queries.ts";
import { findInstanceId } from "../instances/instance_queries.ts";
import type { Context } from "../kernel/context.ts";
import {
    providerDecisions,
    setCardTrendable,
    setProviderTrendable,
    type TrendingCard,
    trendingCards,
} from "./link_queries.ts";
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

/** The domain of a card's website, and each domain it is a subdomain of, the most specific first. */
export const websiteDomains = (url: string): string[] => {
    const { hostname } = new URL(url);
    const labels = (canonicalizeDomain(hostname) ?? hostname).split(".");

    return labels.map((_, i) => labels.slice(i).join("."));
};

/** Whether `card` trends: its own decision, or else its website's, or else `byDefault` decides. */
export const cardState = (
    card: Pick<TrendingCard, "url" | "trendable">,
    decisions: ReadonlyMap<string, boolean>,
    byDefault: boolean,
): TrendState => {
    const domain = websiteDomains(card.url).find((name) => decisions.has(name));
    const website = domain === undefined ? null : decisions.get(domain) ?? null;

    return stateOf(card.trendable ?? website, byDefault);
};

/** What is trending, with whether each is shown. */
export type TrendsForAdmin = {
    readonly tags: readonly { name: string; score: number; state: TrendState }[];
    readonly accounts: readonly { id: string; acct: string; score: number; state: TrendState }[];
    readonly links: readonly { url: string; title: string; score: number; state: TrendState }[];
    /** The websites an admin decided about, whose links trend or not unless a card was decided. */
    readonly domains: readonly { domain: string; trendable: boolean }[];
};

/** What is trending, with whether it is shown, for an admin to review. */
export const trendsForAdmin = async (
    ctx: Context,
    byDefault: boolean,
): Promise<TrendsForAdmin> => {
    const decisions = await providerDecisions(ctx);

    return {
        tags: (await trendingTagsForAdmin(ctx)).map((tag) => ({
            name: tag.name,
            score: tag.score,
            state: stateOf(tag.trendable, byDefault),
        })),
        accounts: (await trendingAccountsForAdmin(ctx)).map((account) => ({
            id: account.id,
            acct: account.domain === null
                ? account.username
                : `${account.username}@${account.domain}`,
            score: account.score,
            state: stateOf(account.trendable, byDefault),
        })),
        links: (await trendingCards(ctx)).map((card) => ({
            url: card.url,
            title: card.title,
            score: card.score,
            state: cardState(card, decisions, byDefault),
        })),
        domains: [...decisions]
            .map(([domain, trendable]) => ({ domain, trendable }))
            .toSorted((a, b) => a.domain.localeCompare(b.domain)),
    };
};

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

/**
 * Lets the link whose card is at `url`, as `trends list` prints it, trend or not. Returns `false`
 * if Verso has no card there.
 */
export const decideLink = (ctx: Context, url: string, trendable: boolean): Promise<boolean> =>
    setCardTrendable(ctx, url, trendable);

/**
 * Lets the links to the website `domain`, and its subdomains, trend or not, unless a link was
 * decided. Returns the domain as stored, or `undefined` if it isn't a domain name.
 */
export const decideDomain = async (
    ctx: Context,
    domain: string,
    trendable: boolean,
): Promise<string | undefined> => {
    const name = canonicalizeDomain(domain);
    if (name === undefined) return undefined;

    await setProviderTrendable(ctx, name, trendable);
    return name;
};
