import { type Context as HonoContext, Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { getLogger } from "@logtape/logtape";
import { Permissions } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import type { Cidr } from "../kernel/ip.ts";
import type { AppEnv, AppServices } from "./env.ts";
import { ContentTooLarge, Defederated, HttpError, NotFound } from "./errors.ts";
import { useHeaders } from "./headers.ts";
import { asOAuthError, inputOf } from "./input.ts";
import { rateLimit, type RateLimits } from "./rate_limits.ts";
import { checkReply, send } from "./reply.ts";
import type { Route } from "./route.ts";
import { signerOf, signReply } from "./signatures.ts";
import { checkPermission, rateLimitKey, viewerOf, withPermissions } from "./viewer.ts";

const logger = getLogger(["verso", "http"]);

/** The largest body a route takes, enough for any form or JSON. Uploads will need their own. */
const maxBodyBytes = 64 * 1024;

/** The reply to a request that failed with `error`. */
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
    /** Checks every reply against its route's declared response schemas. For tests. */
    readonly checkResponses?: boolean;
    /** Without them, requests aren't limited. */
    readonly rateLimits?: RateLimits;
    /** The reverse proxies believed about who the client is. */
    readonly trustedProxies?: readonly Cidr[];
    /** What everyone may do, before roles add more. Without it, what config allows by default. */
    readonly permissions?: Permissions;
    /** Answers blocked instances as if nothing were wrong, rather than with 403. */
    readonly silentBlocks?: boolean;
};

/** Every route the server answers. Tests call its `fetch` directly, with no network in between. */
export const createApp = (
    ctx: Context,
    routes: readonly Route[],
    options: AppOptions,
): App => {
    const app = new Hono<AppEnv>();
    const permissions = options.permissions ?? Permissions.parse({});
    useHeaders(app, ctx.urls.origin);

    // Replies are about one user, or carry secrets such as tokens, so nothing may cache them,
    // unless their route says. Errors skip this, so the error handler sets it too.
    app.use(async (c, next) => {
        await next();
        if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
    });

    // Checked before anything reads the body, so a huge one is refused, not held in memory.
    app.use(bodyLimit({
        maxSize: maxBodyBytes,
        onError: () => {
            throw new ContentTooLarge();
        },
    }));

    /** The route's reply to the request, or the error it threw. */
    const answer = async (route: Route, c: HonoContext<AppEnv>) => {
        const signedBy = route.signed ? await signerOf(ctx, c, options.services) : undefined;
        const bearer = await viewerOf(ctx, c, route, options.services);
        const viewer = bearer && withPermissions(ctx, bearer, permissions, options.services);
        await checkPermission(route, viewer, permissions);
        const input = await inputOf(c, route).catch((error) => {
            throw route.oauthErrors ? asOAuthError(error) : error;
        });

        const reply = await route.handler(ctx, { ...input, viewer, signedBy });
        if (options.checkResponses) checkReply(route, reply);

        return await send(c, route, reply);
    };

    const handle = (route: Route) => {
        app.on(route.method, route.path, async (c) => {
            if (!route.signed) return await answer(route, c);

            // Errors are signed too, so the instance that asked can trust a 404 as much as a 200.
            const response = await answer(route, c).catch((error) =>
                error instanceof Defederated && options.silentBlocks
                    ? silentReply(c)
                    : errorReply(error, c)
            );
            return await signReply(ctx, c, response, options.services);
        });
    };

    // For load balancers and orchestrators, not clients, so it stays plain text.
    app.get("/health/live", (c) => c.text("ok"));

    // Before the rate limit, which runs only for what is added after it.
    for (const route of routes) if (route.rateLimit === false) handle(route);

    // Preflights were answered before this, by the CORS headers.
    const limits = options.rateLimits;
    if (limits) {
        app.use(rateLimit<AppEnv>(
            ctx.clock,
            limits,
            (c) => rateLimitKey(ctx, c, options.trustedProxies ?? [], options.services),
        ));
    }

    for (const route of routes) if (route.rateLimit !== false) handle(route);

    app.notFound(() => {
        throw new NotFound();
    });

    app.onError(errorReply);

    return app;
};
