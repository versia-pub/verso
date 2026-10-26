import { type Context as HonoContext, Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { getLogger } from "@logtape/logtape";
import { Permissions } from "../kernel/config_sections.ts";
import type { Context } from "../kernel/context.ts";
import type { Cidr } from "../kernel/ip.ts";
import type { AppEnv, AppServices } from "./env.ts";
import { ContentTooLarge, Defederated, HttpError, NotFound } from "./errors.ts";
import { useHeaders } from "./headers.ts";
import { asOAuthError, inputOf } from "./input.ts";
import { checkRateLimit, rateLimit, type RateLimits } from "./rate_limits.ts";
import { checkReply, send } from "./reply.ts";
import type { Route } from "./route.ts";
import { signReply, verifyRequest } from "./signatures.ts";
import { checkPermission, rateLimitKey, viewerOf, withPermissions } from "./viewer.ts";

const logger = getLogger(["verso", "http"]);

/**
 * The largest body a route accepts unless it says otherwise: enough for any form or JSON, and for a
 * status as long as a long blog post, of 100,000 characters.
 */
const maxBodyBytes = 256 * 1024;

/** The response to a request that failed with `error`. */
const errorReply = (error: unknown, c: HonoContext<AppEnv>): Response => {
    c.header("cache-control", "no-store");
    if (error instanceof HttpError) return c.json(error, error.status);

    logger.error("{method} {path} failed: {error}", {
        method: c.req.method,
        path: c.req.path,
        error,
    });
    return c.json({ error: "Internal server error" }, 500);
};

/**
 * What a blocked instance is told when blocks are silent, so it can't tell: a GET finds nothing,
 * and anything else is accepted, so it isn't sent again.
 */
const silentReply = (c: HonoContext<AppEnv>): Response =>
    c.req.method === "GET" ? errorReply(new NotFound(), c) : c.body(null, 202);

/** The server's HTTP app. */
export type App = Hono<AppEnv>;

export type AppOptions = {
    readonly services: AppServices;
    /** Validates every response against its route's declared response schemas. For tests. */
    readonly checkResponses?: boolean;
    /** Without them, requests aren't limited. */
    readonly rateLimits?: RateLimits;
    /** The reverse proxies trusted to say who the client is. */
    readonly trustedProxies?: readonly Cidr[];
    /** What everyone may do, before roles add more. Without it, what config allows by default. */
    readonly permissions?: Permissions;
    /** Responds to blocked instances as if nothing were wrong, rather than with 403. */
    readonly silentBlocks?: boolean;
};

/** Every route the server serves. Tests call its `fetch` directly, with no network in between. */
export const createApp = (
    ctx: Context,
    routes: readonly Route[],
    options: AppOptions,
): App => {
    const app = new Hono<AppEnv>();
    const permissions = options.permissions ?? Permissions.parse({});
    useHeaders(app, ctx.urls.origin);

    // Responses are about one user, or carry secrets such as tokens, so nothing may cache them,
    // unless their route says. Errors skip this, so the error handler sets it too.
    app.use(async (c, next) => {
        await next();
        if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
    });

    const limits = options.rateLimits;
    const clientKey = (c: HonoContext<AppEnv>) =>
        rateLimitKey(ctx, c, options.trustedProxies ?? [], options.services);

    /**
     * Validates a signed request's signature, counting the request against the instance that signed
     * it, or, if it isn't validly signed, against its client, like any other request. A signer
     * whose key Verso must fetch is counted against the client first, so a client over its limit
     * can't make Verso fetch keys.
     */
    const verify = async (c: HonoContext<AppEnv>) => {
        if (!limits) return await verifyRequest(ctx, c);

        let counted = false;
        const countClient = async () => {
            counted = true;
            await checkRateLimit(c, ctx.clock, limits.store, limits.policy, await clientKey(c));
        };

        let signed;
        try {
            signed = await verifyRequest(ctx, c, countClient);
        } catch (error) {
            if (!counted) await countClient();
            throw error;
        }

        const key = `instance:${signed.signedBy}`;
        await checkRateLimit(c, ctx.clock, limits.store, limits.instancePolicy, key);
        return signed;
    };

    /** Counts a request to a route with a bucket of its own, as its `rateLimit` says. */
    const countInBucket = async (route: Route, c: HonoContext<AppEnv>) => {
        if (!limits || typeof route.rateLimit !== "object") return;

        const { bucket, times } = route.rateLimit;
        const policy = { ...limits.policy, limit: limits.policy.limit * times };
        await checkRateLimit(c, ctx.clock, limits.store, policy, `${bucket}:${await clientKey(c)}`);
    };

    /** The route's response to the request, or the error it threw. */
    const answer = async (route: Route, c: HonoContext<AppEnv>) => {
        await countInBucket(route, c);
        const signed = route.signed ? await verify(c) : undefined;
        const bearer = await viewerOf(ctx, c, route, options.services);
        const viewer = bearer && withPermissions(ctx, bearer, permissions, options.services);
        await checkPermission(route, viewer, permissions);
        const input = await inputOf(c, route).catch((error) => {
            throw route.oauthErrors ? asOAuthError(error) : error;
        });

        const reply = await route.handler(ctx, {
            ...input,
            viewer,
            signedBy: signed?.signedBy,
            signedBody: signed?.body,
        });
        if (options.checkResponses) checkReply(route, reply);

        return await send(c, route, reply, ctx.urls.origin);
    };

    const handle = (route: Route) => {
        // Checked before anything reads the body, so a huge one is rejected, not held in memory.
        const limit = bodyLimit({
            maxSize: route.maxBodyBytes ?? maxBodyBytes,
            onError: () => {
                throw new ContentTooLarge();
            },
        });

        app.on(route.method, route.path, limit, async (c) => {
            if (!route.signed) return await answer(route, c);

            // Errors are signed too, so the instance that sent the request can trust a 404 as much
            // as a 200.
            const response = await answer(route, c).catch((error) =>
                error instanceof Defederated && options.silentBlocks
                    ? silentReply(c)
                    : errorReply(error, c)
            );
            return await signReply(ctx, c, response);
        });
    };

    // For load balancers and orchestrators, not clients, so it stays plain text.
    app.get("/health/live", (c) => c.text("ok"));

    // Before the clients' rate limit, which runs only for what is added after it. Signed routes are
    // limited by who signed, once the signature is validated, and routes with a bucket in it.
    const unlimited = (route: Route) => route.rateLimit !== undefined || route.signed === true;
    for (const route of routes) if (unlimited(route)) handle(route);

    // Preflights were handled before this, by the CORS headers.
    if (limits) app.use(rateLimit<AppEnv>(ctx.clock, limits, clientKey));

    for (const route of routes) if (!unlimited(route)) handle(route);

    app.notFound(() => {
        throw new NotFound();
    });

    app.onError(errorReply);

    return app;
};
