/**
 * Request IDs and access logs. Each request gets an ID, sent back in `X-Request-Id` and added to
 * every log line written while it is handled. Access logs are at debug, so only `level = "debug"`
 * shows them.
 * @module
 */
import type { Hono } from "@hono/hono";
import { honoLogger } from "@logtape/hono";
import type { Cidr } from "../kernel/ip.ts";
import { trusted } from "./client_ip.ts";
import type { AppEnv } from "./env.ts";

/**
 * What is kept of an `X-Request-Id` from a trusted proxy: up to 255 letters, digits, `_`, `-` and
 * `@`, the same as Rails.
 * @see https://github.com/rails/rails/blob/v8.1.3.1/actionpack/lib/action_dispatch/middleware/request_id.rb
 */
const cleanRequestId = (given: string): string => given.replace(/[^\w\-@]/g, "").slice(0, 255);

/**
 * The request's ID: the `X-Request-Id` a trusted proxy sent, so its logs and Verso's match, or else
 * a new one. Anyone else's is ignored, since it could be made to look like another request's.
 */
export const requestId = (
    given: string | undefined,
    peer: string | undefined,
    proxies: readonly Cidr[],
): string => {
    const cleaned = given !== undefined && peer !== undefined && trusted(peer, proxies)
        ? cleanRequestId(given)
        : "";

    return cleaned || crypto.randomUUID();
};

/** Query parameters that can carry a secret, such as an access token or an authorization code. */
const secretParameters =
    /([?&](?:access_token|client_secret|code|code_verifier|password|refresh_token|state|token)=)[^&#]*/gi;

/** The path and query of `url`, with the values of secret query parameters replaced. */
export const redactedTarget = (url: string): string => {
    const { pathname, search } = new URL(url);
    return pathname + search.replace(secretParameters, "$1[FILTERED]");
};

/** Load balancers ask often, so these aren't logged. */
const isHealthCheck = (path: string): boolean => path === "/health" || path.startsWith("/health/");

/** Gives each request an ID and logs it once answered. Add it before anything else. */
export const useRequestLog = (app: Hono<AppEnv>, trustedProxies: readonly Cidr[]): void => {
    // Before the CORS headers, which answer preflights themselves.
    app.use(async (c, next) => {
        const id = requestId(
            c.req.header("x-request-id"),
            c.env?.remoteAddr?.hostname,
            trustedProxies,
        );
        c.set("requestId", id);

        await next();

        c.header("x-request-id", id);
    });

    app.use(honoLogger({
        category: ["verso", "http", "access"],
        level: "debug",
        skip: (c) => isHealthCheck(c.req.path),
        format: (c, responseTime) => ({
            method: c.req.method,
            url: redactedTarget(c.req.url),
            status: c.res.status,
            responseTime,
        }),
        // The line for a streamed response is only written when it ends, so the ID is added here.
        context: { requestId: false, enrich: (c) => ({ requestId: c.get("requestId") }) },
    }));
};
