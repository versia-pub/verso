/**
 * Checking Versia signatures with the keys Verso has for other instances.
 * @see https://versia.pub/signatures
 * @module
 */
import { type SignedMessage, type Verification, verify } from "@versia/protocol";
import type { Context } from "./context.ts";

/** Other instances' public keys, by domain. */
export type KeyStore = {
    /** The key Verso has for the instance, or else fetches from it. */
    readonly get: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
    /** Fetches the key again, in case the instance rotated it, but only so often. */
    readonly refresh: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
};

/**
 * Checks the signature on `message`. When the key Verso has for the signer doesn't verify it, the
 * key is fetched again, in case the instance rotated it. With `from`, only that domain may have
 * signed it, and no other instance's key is looked up.
 */
export const checkSignature = async (
    ctx: Context,
    keys: KeyStore,
    message: SignedMessage,
    headers: Headers,
    from?: string,
): Promise<Verification> => {
    const now = ctx.clock.now();
    const allowed = (domain: string) => from === undefined || domain === from;

    let known = false;
    const first = await verify(message, headers, async (domain) => {
        const key = allowed(domain) ? await keys.get(ctx, domain) : undefined;
        known = key !== undefined;
        return key;
    }, now);

    if (first.ok || first.reason === "expired" || !known) return first;

    return await verify(message, headers, (domain) => keys.refresh(ctx, domain), now);
};
