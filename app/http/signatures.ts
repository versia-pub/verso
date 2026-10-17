/**
 * Versia signatures on requests from other instances, and on the replies to them.
 * @see https://versia.pub/signatures
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import { sign, verify } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import type { AppServices } from "./env.ts";
import { BadSignature, StaleSignature } from "./errors.ts";

/**
 * The domain of the instance that signed the request. When the key Verso has for it doesn't
 * verify, the key is fetched again, at most so often, in case the instance rotated it.
 */
export const signerOf = async (
    ctx: Context,
    c: HonoContext,
    keys: AppServices["remoteKeys"],
): Promise<string> => {
    const message = {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
        body: new Uint8Array(await c.req.arrayBuffer()),
    };
    const now = ctx.clock.now();

    let known = false;
    const first = await verify(message, c.req.raw.headers, async (domain) => {
        const key = await keys.get(ctx, domain);
        known = key !== undefined;
        return key;
    }, now);

    if (first.ok) return first.signedBy;
    if (first.reason === "expired") throw new StaleSignature();
    if (!known) throw new BadSignature();

    const again = await verify(
        message,
        c.req.raw.headers,
        (domain) => keys.refresh(ctx, domain),
        now,
    );
    if (!again.ok) throw new BadSignature();

    return again.signedBy;
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
