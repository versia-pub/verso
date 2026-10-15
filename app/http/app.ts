import { type Context as HonoContext, Hono } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import {
    BadRequest,
    HttpError,
    NotFound,
    UnsupportedMediaType,
    ValidationFailed,
} from "./errors.ts";
import {
    type CookieChanges,
    Page,
    Redirect,
    type Reply,
    type Responses,
    type Route,
} from "./route.ts";

const logger = getLogger(["verso", "http"]);

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

const queryOf = (c: HonoContext) =>
    Object.fromEntries(
        Object.entries(c.req.queries()).map(([key, values]) => [
            key,
            values.length === 1 ? values[0] : values,
        ]),
    );

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

const isSchema = (declared: NonNullable<Responses[200]>): declared is z.ZodType =>
    declared !== Page && declared !== Redirect;

/** Why a reply doesn't match what its route declares for its status, if it doesn't. */
const replyProblem = (route: Route, reply: Reply<Responses>) => {
    const declared = route.responses[reply.status];

    if (declared === undefined) return "the status isn't declared";
    if (declared === Page) return "page" in reply ? undefined : "it isn't a page";
    if (declared === Redirect) return "location" in reply ? undefined : "it isn't a redirect";
    if (!isSchema(declared) || !("body" in reply)) return "it has no body";

    const result = declared.safeParse(reply.body);
    return result.success ? undefined : z.prettifyError(result.error);
};

/** Throws when a reply doesn't match what its route declares for its status. */
const checkReply = (route: Route, reply: Reply<Responses>) => {
    const problem = replyProblem(route, reply);
    if (problem === undefined) return;

    throw new Error(
        `${route.method} ${route.path} replied ${reply.status} with an undeclared shape: ${problem}`,
    );
};

/** For pages: no scripts or framing, so a page like the consent form can't be clickjacked. */
const pageHeaders = {
    "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
};

const send = (c: HonoContext, reply: Reply<Responses>) => {
    setCookies(c, reply.cookies);

    if ("location" in reply) return c.redirect(reply.location, reply.status);
    if ("page" in reply) return c.html(reply.page, reply.status, pageHeaders);

    return c.json(reply.body, reply.status);
};

export type AppOptions = {
    /** Checks every reply against its route's declared response schemas. For tests. */
    readonly checkResponses?: boolean;
};

/** Every route the server answers. Tests call its `fetch` directly, with no network in between. */
export const createApp = (
    ctx: Context,
    routes: readonly Route[],
    options: AppOptions = {},
): Hono => {
    const app = new Hono();

    // Replies are about one user, or carry secrets such as tokens, so nothing may cache them.
    // Errors skip this, so the error handler sets it too.
    app.use(async (c, next) => {
        await next();
        c.res.headers.set("cache-control", "no-store");
    });

    // For load balancers and orchestrators, not clients, so it stays plain text.
    app.get("/health/live", (c) => c.text("ok"));

    for (const route of routes) {
        app.on(route.method, route.path, async (c) => {
            const input = validate({
                params: { schema: route.params, value: c.req.param() },
                query: { schema: route.query, value: queryOf(c) },
                body: { schema: route.body, value: await bodyOf(c, route) },
                cookies: { schema: route.cookies, value: cookiesOf(c) },
                headers: { schema: route.headers, value: c.req.header() },
            });

            const reply = await route.handler(ctx, input);
            if (options.checkResponses) checkReply(route, reply);

            return send(c, reply);
        });
    }

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
