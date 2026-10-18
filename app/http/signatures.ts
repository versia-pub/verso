/**
 * Versia signatures on requests from other instances, and on the replies to them.
 * @see https://versia.pub/signatures
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import { sign } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import { checkSignature, type KeyStore } from "../kernel/signatures.ts";
import type { AppServices } from "./env.ts";
import { BadSignature, Defederated, StaleSignature } from "./errors.ts";

/** A request with a valid signature: who signed it, and the body they signed. */
export type SignedRequest = {
    readonly signedBy: string;
    readonly body: Uint8Array<ArrayBuffer>;
};

/**
 * Checks the request's signature, and gives who signed it. When the key Verso has for it doesn't
 * verify, the key is fetched again, at most so often, in case the instance rotated it. A blocked
 * instance is refused once the headers are checked, before its key is looked up, so Verso never
 * sends it a request.
 */
export const verifyRequest = async (
    ctx: Context,
    c: HonoContext,
    services: AppServices,
): Promise<SignedRequest> => {
    const message = {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
        body: new Uint8Array(await c.req.arrayBuffer()),
    };

    let blocked = false;
    const keys: KeyStore = {
        get: async (ctx, domain) => {
            blocked = await services.isBlocked(ctx, domain);
            return blocked ? undefined : await services.remoteKeys.get(ctx, domain);
        },
        refresh: services.remoteKeys.refresh,
    };

    const verification = await checkSignature(ctx, keys, message, c.req.raw.headers);
    if (verification.ok) return { signedBy: verification.signedBy, body: message.body };
    if (blocked) throw new Defederated();

    throw verification.reason === "expired" ? new StaleSignature() : new BadSignature();
};

/**
 * Signs a reply as this instance, over the request's method and path and the reply's exact bytes,
 * so the instance that asked can tell it came from here unchanged.
 * @see https://versia.pub/signatures
 */
export const signReply = async (
    ctx: Context,
    c: HonoContext,
    response: Response,
    services: AppServices,
): Promise<Response> => {
    const headers = await sign(
        {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
            body: new Uint8Array(await response.clone().arrayBuffer()),
        },
        await services.signingKey(ctx),
        ctx.urls.domain,
        ctx.clock.now(),
    );

    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
};
