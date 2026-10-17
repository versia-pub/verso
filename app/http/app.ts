import { type Context as HonoContext, Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { deleteCookie, setCookie } from "@hono/hono/cookie";
import { getLogger } from "@logtape/logtape";
import { sign, verify } from "@versia/protocol";
import { z } from "zod";
import { Permissions } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import type { Cidr } from "../kernel/ip.ts";
import { BadSignature, ContentTooLarge, HttpError, NotFound, StaleSignature } from "./errors.ts";
import type { AppEnv, AppServices } from "./env.ts";
import { useHeaders } from "./headers.ts";
import { asOAuthError, inputOf } from "./input.ts";
import { rateLimit, type RateLimits } from "./rate_limits.ts";
import { checkPermission, rateLimitKey, viewerOf, withPermissions } from "./viewer.ts";
import {
    type CookieChanges,
    Page,
    Redirect,
    type Reply,
    type Responses,
    type Route,
} from "./route.ts";

const logger = getLogger(["verso", "http"]);

/** The largest body a route takes, enough for any form or JSON. Uploads will need their own. */
const maxBodyBytes = 64 * 1024;

const setCookies = (c: HonoContext, cookies: CookieChanges = {}) => {
    for (const [name, value] of Object.entries(cookies)) {
        if (value === null) {
            deleteCookie(c, name, { prefix: "host" });
        } else {
            setCookie(c, name, value, { prefix: "host", httpOnly: true, sameSite: "Lax" });
        }
    }
};

const isSchema = (declared: NonNullable<Responses[200]>): declared is z.ZodType =>
    declared instanceof z.ZodType;

/** Why a reply doesn't match what its route declares for its status, if it doesn't. */
const replyProblem = (route: Route, reply: Reply<Responses>) => {
    const declared = route.responses[reply.status];

    if (declared === undefined) return "the status isn't declared";
    if (declared === Page) return "page" in reply ? undefined : "it isn't a page";
    if (declared === Redirect) return "location" in reply ? undefined : "it isn't a redirect";
    if (!isSchema(declared)) return "file" in reply ? undefined : "it isn't a file";
    if (!("body" in reply)) return "it has no body";

    const result = declared.safeParse(reply.body);
    return result.success ? undefined : z.prettifyError(result.error);
};

/** Throws when a reply doesn't match what its route declares for its status. */
const checkReply = (route: Route, reply: Reply<Responses>) => {
    const problem = replyProblem(route, reply);
    if (problem === undefined) return;

    throw new Error(
        `${route.method} ${route.path} replied ${reply.status} with an undeclared shape: ` +
            problem,
    );
};

/**
 * For pages: no scripts unless the route allows them, and never framing, so a page like the consent
 * form can't be clickjacked.
 */
const pageHeaders = (route: Route) => ({
    "content-security-policy": `${
        route.pagePolicy ?? "default-src 'none'; style-src 'unsafe-inline'"
    }; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
});

const send = (c: HonoContext, route: Route, reply: Reply<Responses>) => {
    setCookies(c, reply.cookies);

    if (route.maxAge !== undefined && reply.status < 300) {
        c.header("cache-control", `public, max-age=${route.maxAge}`);
    }

    if ("location" in reply) return c.redirect(reply.location, reply.status);
    if ("page" in reply) return c.html(reply.page, reply.status, pageHeaders(route));

    if ("file" in reply) {
        const declared = route.responses[reply.status];
        const type = declared && "type" in declared ? declared.type : "application/octet-stream";

        return c.body(new Uint8Array(reply.file), reply.status, { "content-type": type });
    }

    return route.contentType === undefined
        ? c.json(reply.body, reply.status)
        : c.body(JSON.stringify(reply.body), reply.status, { "content-type": route.contentType });
};

/**
 * The domain of the instance that signed the request. When the key Verso has for it doesn't
 * verify, the key is fetched again, at most so often, in case the instance rotated it.
 */
const signerOf = async (ctx: Context, c: HonoContext, keys: AppServices["remoteKeys"]) => {
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
const signReply = async (
    ctx: Context,
    c: HonoContext,
    response: Response,
    services: AppServices,
) => {
    const headers = await sign(
        {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
            body: new Uint8Array(await response.clone().arrayBuffer()),
        },
        await services.signingKey(ctx),
        new URL(ctx.urls.origin).hostname,
        ctx.clock.now(),
    );

    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
};

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

    const handle = (route: Route) => {
        app.on(route.method, route.path, async (c) => {
            const signedBy = route.signed
                ? await signerOf(ctx, c, options.services.remoteKeys)
                : undefined;
            const bearer = await viewerOf(ctx, c, route, options.services);
            const viewer = bearer && withPermissions(ctx, bearer, permissions, options.services);
            await checkPermission(route, viewer, permissions);
            const input = await inputOf(c, route).catch((error) => {
                throw route.oauthErrors ? asOAuthError(error) : error;
            });

            const reply = await route.handler(ctx, { ...input, viewer, signedBy });
            if (options.checkResponses) checkReply(route, reply);

            const response = await send(c, route, reply);
            return route.signed ? await signReply(ctx, c, response, options.services) : response;
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

    app.onError((error, c) => {
        c.header("cache-control", "no-store");
        if (error instanceof HttpError) return c.json(error, error.status);

        logger.error("{method} {path} failed: {error}", {
            method: c.req.method,
            path: c.req.path,
            error,
        });
        return c.json({ error: "Internal server error" }, 500);
    });

    return app;
};
