/**
 * A route's response, as the HTTP response sent: JSON, a list, a page, a redirect or a file, with
 * its cookies.
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import { deleteCookie, setCookie } from "@hono/hono/cookie";
import { z } from "zod";
import { linkHeader } from "./paging.ts";
import { type Route } from "./route.ts";
import { type CookieChanges, type Reply, type Responses } from "./responses.ts";

const setCookies = (c: HonoContext, cookies: CookieChanges = {}) => {
    for (const [name, value] of Object.entries(cookies)) {
        if (value === null) {
            deleteCookie(c, name, { prefix: "host" });
        } else {
            setCookie(c, name, value, { prefix: "host", httpOnly: true, sameSite: "Lax" });
        }
    }
};

const yearSeconds = 365 * 24 * 60 * 60;

const isSchema = (declared: NonNullable<Responses[200]>): declared is z.ZodType =>
    declared instanceof z.ZodType;

/**
 * Why a response's body doesn't match `schema`, or doesn't have cursors if it is a page of a list,
 * if it doesn't.
 */
const bodyProblem = (reply: Reply<Responses>, schema: z.ZodType, paged: boolean) => {
    if (!("body" in reply)) return "it has no body";
    if (paged !== "cursors" in reply) return paged ? "it has no cursors" : "it has cursors";

    const result = schema.safeParse(reply.body);
    return result.success ? undefined : z.prettifyError(result.error);
};

/** Why a response doesn't match what its route declares for its status, if it doesn't. */
const replyProblem = (route: Route, reply: Reply<Responses>) => {
    const declared = route.responses[reply.status];

    if (declared === undefined) return "the status isn't declared";
    if (isSchema(declared)) return bodyProblem(reply, declared, false);

    switch (declared.kind) {
        case "page":
            return "page" in reply ? undefined : "it isn't a page";
        case "redirect":
            return "location" in reply ? undefined : "it isn't a redirect";
        case "binary":
            return "file" in reply ? undefined : "it isn't a file";
        case "paged":
            return bodyProblem(reply, z.array(declared.item), true);
        case "linked":
            return bodyProblem(reply, declared.body, true);
        case "upgrade":
            return "socket" in reply ? undefined : "it isn't a WebSocket";
        case "none": {
            const empty = Object.keys(reply).every((key) => key === "status" || key === "cookies");
            return empty ? undefined : "it has a body";
        }
    }
};

/** Throws when a response doesn't match what its route declares for its status. */
export const checkReply = (route: Route, reply: Reply<Responses>): void => {
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

/**
 * Sends `reply` as the response to the request in `c`, which arrived at `origin`, which Verso's
 * public URLs start with, as links to other pages of a list do too.
 */
export const send = (
    c: HonoContext,
    route: Route,
    reply: Reply<Responses>,
    origin: string,
): Response | Promise<Response> => {
    setCookies(c, reply.cookies);

    if ("cursors" in reply) {
        const asked = new URL(c.req.url);
        const link = linkHeader(new URL(asked.pathname + asked.search, origin), reply.cursors);
        if (link !== undefined) c.header("link", link);
    }

    const maxAge = route.immutable ? yearSeconds : route.maxAge;
    if (maxAge !== undefined && reply.status < 300) {
        c.header(
            "cache-control",
            `public, max-age=${maxAge}${route.immutable ? ", immutable" : ""}`,
        );
    }

    if ("socket" in reply) {
        // Deno pings every half a minute, and closes connections that stop answering.
        const { socket, response } = Deno.upgradeWebSocket(c.req.raw, {
            protocol: reply.protocol,
            idleTimeout: 30,
        });
        reply.socket(socket);
        return response;
    }

    // So that the status is one with a body, as only a WebSocket's can't have one.
    if (reply.status === 101) throw new Error(`${route.path} switched protocols without a socket`);

    if ("location" in reply) return c.redirect(reply.location, reply.status);
    if ("page" in reply) return c.html(reply.page, reply.status, pageHeaders(route));

    if ("file" in reply) {
        const declared = route.responses[reply.status];
        const type = reply.type ??
            (declared && "type" in declared ? declared.type : "application/octet-stream");
        const file = reply.file instanceof Uint8Array ? new Uint8Array(reply.file) : reply.file;

        return c.body(file, reply.status, {
            "content-type": type,
            ...reply.download && { "content-disposition": "attachment" },
        });
    }

    if (!("body" in reply)) return c.body(null, reply.status);

    return route.contentType === undefined
        ? c.json(reply.body, reply.status)
        : c.body(JSON.stringify(reply.body), reply.status, { "content-type": route.contentType });
};
