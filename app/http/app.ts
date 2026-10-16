import { type Context as HonoContext, Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { grants } from "../auth/scopes.ts";
import { authenticateToken, type Viewer } from "../auth/tokens.ts";
import type { Context } from "../kernel/context.ts";
import { type Cidr, parseAddress } from "../kernel/ip.ts";
import { clientIp } from "./client_ip.ts";
import {
    BadRequest,
    ContentTooLarge,
    Forbidden,
    HttpError,
    NotFound,
    Unauthorized,
    UnsupportedMediaType,
    UserRequired,
    ValidationFailed,
} from "./errors.ts";
import { useHeaders } from "./headers.ts";
import { rateLimit, type RateLimits } from "./rate_limits.ts";
import {
    type CookieChanges,
    Page,
    Redirect,
    type Reply,
    type Responses,
    type Route,
} from "./route.ts";

const logger = getLogger(["verso", "http"]);

/** What Hono carries for each request. */
type AppEnv = {
    /** From `Deno.serve`. Tests that call the app directly may leave it out. */
    Bindings: { readonly remoteAddr?: { readonly hostname: string } } | undefined;
    Variables: { bearer?: Promise<Viewer | undefined> };
};

/** The largest body a route takes, enough for any form or JSON. Uploads will need their own. */
const maxBodyBytes = 64 * 1024;

/** Parses each part of the input, reporting every problem in all parts at once. */
const validate = <K extends string>(
    parts: Record<K, { schema: z.ZodType | undefined; value: unknown }>,
): Record<K, unknown> => {
    const valid: Partial<Record<K, unknown>> = {};
    const details: Record<string, string[]> = {};

    for (const [part, { schema, value }] of Object.entries(parts) as [K, typeof parts[K]][]) {
        const result = (schema ?? z.object({})).safeParse(value);
        if (result.success) valid[part] = result.data;

        for (const issue of result.error?.issues ?? []) {
            const path = [part, ...issue.path.map(String)].join(".");
            (details[path] ??= []).push(issue.message);
        }
    }

    if (Object.keys(details).length > 0) throw new ValidationFailed(details);
    return valid as Record<K, unknown>;
};

/**
 * The query's values. A key given more than once is an array, and so is a Rails-style `key[]`,
 * read as `key`, even when given once.
 */
const queryOf = (c: HonoContext) => {
    const values = new Map<string, string[]>();
    const arrays = new Set<string>();

    for (const [key, given] of Object.entries(c.req.queries())) {
        const name = key.replace(/\[\]$/, "");
        if (name !== key) arrays.add(name);

        values.set(name, [...values.get(name) ?? [], ...given]);
    }

    return Object.fromEntries(
        [...values].map(([name, given]) => [
            name,
            given.length === 1 && !arrays.has(name) ? given[0] : given,
        ]),
    );
};

/**
 * Verso's cookies, without their `__Host-` prefix. Browsers only accept such cookies from this
 * host over HTTPS, so a subdomain or an insecure page can't plant one.
 */
const cookiesOf = (c: HonoContext) =>
    Object.fromEntries(
        Object.entries(getCookie(c))
            .filter(([name]) => name.startsWith("__Host-"))
            .map(([name, value]) => [name.slice("__Host-".length), value]),
    );

const setCookies = (c: HonoContext, cookies: CookieChanges = {}) => {
    for (const [name, value] of Object.entries(cookies)) {
        if (value === null) {
            deleteCookie(c, name, { prefix: "host" });
        } else {
            setCookie(c, name, value, { prefix: "host", httpOnly: true, sameSite: "Lax" });
        }
    }
};

/** A form's fields, with Rails-style `key[]` names read as `key`. */
const formOf = async (c: HonoContext) => {
    const form = await c.req.parseBody({ all: true });

    return Object.fromEntries(
        Object.entries(form).map(([key, value]) => [key.replace(/\[\]$/, ""), value]),
    );
};

/** Mastodon clients send JSON or forms, so every route accepts both. */
const bodyOf = async (c: HonoContext, route: Route) => {
    if (!route.body) return {};

    const type = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    const forms = ["application/x-www-form-urlencoded", "multipart/form-data"];

    if (type !== "application/json" && !forms.includes(type ?? "")) {
        throw new UnsupportedMediaType("The body must be JSON or a form");
    }

    try {
        return type === "application/json" ? await c.req.json() : await formOf(c);
    } catch {
        throw new BadRequest("The body isn't valid JSON or form data");
    }
};

/** The route's validated input, or the reason it isn't valid. */
const inputOf = async (c: HonoContext, route: Route) =>
    validate({
        params: { schema: route.params, value: c.req.param() },
        query: { schema: route.query, value: queryOf(c) },
        body: { schema: route.body, value: await bodyOf(c, route) },
        cookies: { schema: route.cookies, value: cookiesOf(c) },
        headers: { schema: route.headers, value: c.req.header() },
    });

/** An input error as OAuth's `invalid_request`, naming what was wrong. */
const asOAuthError = (error: unknown) => {
    if (error instanceof ValidationFailed) {
        const fields = Object.keys(error.details).join(", ");
        return new HttpError(400, "invalid_request", `These are invalid: ${fields}.`);
    }

    return error instanceof HttpError
        ? new HttpError(400, "invalid_request", error.description ?? error.message)
        : error;
};

const isSchema = (declared: NonNullable<Responses[200]>): declared is z.ZodType =>
    declared instanceof z.ZodType;

/**
 * Who is calling, checked against the route's `auth` as Mastodon checks it. A token sent where none
 * is needed is ignored; on other routes, a token sent must be valid.
 */
const viewerOf = async (ctx: Context, c: HonoContext<AppEnv>, route: Route) => {
    if (!route.auth) return undefined;

    if (c.req.header("authorization") === undefined && route.auth.require === "optional") {
        return undefined;
    }

    const viewer = await bearerOf(ctx, c);

    if (!viewer) throw new Unauthorized();
    if (route.auth.require === "user" && viewer.accountId === null) throw new UserRequired();
    if (route.auth.scope && !grants(viewer.scopes, route.auth.scope)) throw new Forbidden();

    return viewer;
};

/**
 * The viewer the request's bearer token stands for, if it is valid. It is looked up once, though
 * both the rate limit and the route ask.
 */
const bearerOf = (ctx: Context, c: HonoContext<AppEnv>) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (token === undefined) return Promise.resolve(undefined);

    const bearer = c.get("bearer") ?? authenticateToken(ctx, token);
    c.set("bearer", bearer);

    return bearer;
};

/**
 * Who a request counts against: its access token, if valid, or else the client's IP address. A
 * token that isn't valid doesn't count, or a client could send a new made-up one each time.
 */
const rateLimitKey = async (
    ctx: Context,
    c: HonoContext<AppEnv>,
    trustedProxies: readonly Cidr[],
) => {
    const viewer = await bearerOf(ctx, c);
    if (viewer) return `token:${viewer.tokenId}`;

    const peer = c.env?.remoteAddr?.hostname ?? "unknown";
    const ip = clientIp(peer, c.req.header("x-forwarded-for"), trustedProxies);
    const address = parseAddress(ip);

    // A machine is usually given a whole /64 of IPv6 addresses, so it counts as one client.
    return address?.bits === 128 ? `ip:${(address.value >> 64n).toString(16)}/64` : `ip:${ip}`;
};

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

/** For pages: no scripts or framing, so a page like the consent form can't be clickjacked. */
const pageHeaders = {
    "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
};

const send = (c: HonoContext, route: Route, reply: Reply<Responses>) => {
    setCookies(c, reply.cookies);

    if (route.maxAge !== undefined && reply.status < 300) {
        c.header("cache-control", `public, max-age=${route.maxAge}`);
    }

    if ("location" in reply) return c.redirect(reply.location, reply.status);
    if ("page" in reply) return c.html(reply.page, reply.status, pageHeaders);

    if ("file" in reply) {
        const declared = route.responses[reply.status];
        const type = declared && "type" in declared ? declared.type : "application/octet-stream";

        return c.body(new Uint8Array(reply.file), reply.status, { "content-type": type });
    }

    return route.contentType === undefined
        ? c.json(reply.body, reply.status)
        : c.body(JSON.stringify(reply.body), reply.status, { "content-type": route.contentType });
};

/** The server's HTTP app. */
export type App = Hono<AppEnv>;

export type AppOptions = {
    /** Checks every reply against its route's declared response schemas. For tests. */
    readonly checkResponses?: boolean;
    /** Without them, requests aren't limited. */
    readonly rateLimits?: RateLimits;
    /** The reverse proxies believed about who the client is. */
    readonly trustedProxies?: readonly Cidr[];
};

/** Every route the server answers. Tests call its `fetch` directly, with no network in between. */
export const createApp = (
    ctx: Context,
    routes: readonly Route[],
    options: AppOptions = {},
): App => {
    const app = new Hono<AppEnv>();
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
            const viewer = await viewerOf(ctx, c, route);
            const input = await inputOf(c, route).catch((error) => {
                throw route.oauthErrors ? asOAuthError(error) : error;
            });

            const reply = await route.handler(ctx, { ...input, viewer });
            if (options.checkResponses) checkReply(route, reply);

            return send(c, route, reply);
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
            (c) => rateLimitKey(ctx, c, options.trustedProxies ?? []),
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
