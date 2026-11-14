/**
 * Validating Versia signatures with the keys Verso has for remote instances.
 * @see https://versia.pub/signatures
 * @module
 */
import { v0_7 } from "@versia/protocol";
import type { Context, KeyStore } from "./context.ts";

/**
 * Validates the signature on `message`. When the key Verso has for the signer doesn't verify it,
 * the key is fetched again, in case the instance rotated it. With `from`, only that domain may have
 * signed it, and no other instance's key is looked up.
 */
export const checkSignature = async (
    ctx: Context,
    keys: KeyStore,
    message: v0_7.SignedMessage,
    headers: Headers,
    from?: string,
): Promise<v0_7.Verification> => {
    const now = ctx.clock.now();
    const allowed = (domain: string) => from === undefined || domain === from;

    let known = false;
    const first = await v0_7.verify(message, headers, async (domain) => {
        const key = allowed(domain) ? await keys.get(ctx, domain) : undefined;
        known = key !== undefined;
        return key;
    }, now);

    // `known` is only set once the headers and timestamp are valid, so a stale signature never
    // refetches a key.
    if (first.ok || !known) return first;

    return await v0_7.verify(message, headers, (domain) => keys.refresh(ctx, domain), now);
};
