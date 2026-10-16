/**
 * Headers every reply carries: CORS, so web clients on other sites can call the API, and a few that
 * stop browsers from misusing replies.
 * @module
 */
import type { Env, Hono, MiddlewareHandler } from "@hono/hono";
import { cors } from "@hono/hono/cors";

/** Headers scripts on other sites may read, besides the few browsers always allow. */
const exposed = [
    "Link",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "Retry-After",
];

/**
 * Lets any site call these paths with these methods, without cookies, as Mastodon does. Access
 * tokens travel in a header, so another site learns nothing it couldn't already read itself.
 * @see https://github.com/mastodon/mastodon/blob/main/config/initializers/cors.rb
 */
const corsRules = [
    { path: "/.well-known/*", methods: ["GET"] },
    { path: "/api/*", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    { path: "/oauth/token", methods: ["POST"] },
    { path: "/oauth/revoke", methods: ["POST"] },
];

/**
 * Stops browsers from guessing a reply's type, framing it, or sending the page's URL on. Pages set a
 * stricter policy of their own. HSTS is only sent over HTTPS, where browsers heed it.
 */
const securityHeaders = (https: boolean): MiddlewareHandler => async (c, next) => {
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("referrer-policy", "no-referrer");
    if (https) c.header("strict-transport-security", "max-age=31536000");

    await next();
};

/**
 * Adds the headers to `app`, before anything else, so errors carry them too. A web client can't
 * read an error without CORS headers on it.
 */
export const useHeaders = <E extends Env>(app: Hono<E>, origin: string): void => {
    app.use(securityHeaders(origin.startsWith("https://")));

    for (const { path, methods } of corsRules) {
        app.use(path, cors({ origin: "*", allowMethods: methods, exposeHeaders: exposed }));
    }
};
