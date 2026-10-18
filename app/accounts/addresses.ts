/**
 * Finding accounts by their address, such as `bob` or `bob@b.example`.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { canonicalizeDomain } from "@versia/protocol";
import { isRemoteFailure } from "../federation/resolver.ts";
import { webfinger } from "../federation/webfinger.ts";
import type { Context } from "../kernel/context.ts";
import {
    type AccountRow,
    findAccount,
    findLocalAccount,
    findRemoteAccountByName,
} from "./accounts.ts";

const logger = getLogger(["verso", "accounts"]);

/** A username, and the domain of its instance, or `null` for this one. */
export type Address = { readonly username: string; readonly domain: string | null };

/** The address in `user`, `@user` or `user@domain`, or `undefined` if it isn't one. */
export const parseAddress = (ctx: Context, acct: string): Address | undefined => {
    const [username, domain, ...rest] = acct.replace(/^@/, "").split("@");
    if (username === "" || rest.length > 0) return undefined;
    if (domain === undefined) return { username, domain: null };

    const canonical = canonicalizeDomain(domain);
    if (canonical === undefined) return undefined;

    return { username, domain: canonical === ctx.urls.domain ? null : canonical };
};

/**
 * The account at `address`, or `undefined` if there is none. With `fetch`, a remote account is
 * found with WebFinger if Verso doesn't know it, and fetched again if Verso had it too long ago;
 * if its instance fails, the copy Verso has is used.
 */
export const findAccountByAddress = async (
    ctx: Context,
    address: Address,
    options: { readonly fetch: boolean },
): Promise<AccountRow | undefined> => {
    const { username, domain } = address;
    if (domain === null) return await findLocalAccount(ctx, username);

    const known = await findRemoteAccountByName(ctx, username, domain);
    if (!options.fetch) return known;

    try {
        const reference = known?.remote_id
            ? { host: domain, id: known.remote_id }
            : await webfinger(ctx, username, domain);
        if (reference === undefined) return undefined;

        const id = await ctx.federation.resolve(ctx, reference, "User");
        const found = id === undefined ? undefined : await findAccount(ctx, id);

        // The instance may have pointed at another of its users.
        return found?.username.toLowerCase() === username.toLowerCase() ? found : undefined;
    } catch (error) {
        if (!isRemoteFailure(error)) throw error;

        // Only when Verso doesn't have the account: if it does, the resolver uses that instead.
        logger.warn("Couldn't find {username}@{domain}: {error}", { username, domain, error });
        return undefined;
    }
};
