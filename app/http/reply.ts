/**
 * A route's reply, as the response sent: JSON, a list, a page, a redirect or a file, with its
 * cookies.
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import { deleteCookie, setCookie } from "@hono/hono/cookie";
import { z } from "zod";
import { linkHeader } from "./paging.ts";
import { type CookieChanges, type Reply, type Responses, type Route } from "./route.ts";

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

/** Why a reply's body doesn't match `schema`, or a page of a list of it, if it doesn't. */
const bodyProblem = (reply: Reply<Responses>, schema: z.ZodType, paged: boolean) => {
    if (!("body" in reply)) return "it has no body";
    if (paged !== "cursors" in reply) return paged ? "it has no cursors" : "it has cursors";

    const result = (paged ? z.array(schema) : schema).safeParse(reply.body);
    return result.success ? undefined : z.prettifyError(result.error);
};

/** Why a reply doesn't match what its route declares for its status, if it doesn't. */
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
            return bodyProblem(reply, declared.item, true);
        case "none": {
            const empty = Object.keys(reply).every((key) => key === "status" || key === "cookies");
            return empty ? undefined : "it has a body";
        }
    }
};

/** Throws when a reply doesn't match what its route declares for its status. */
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
 * Sends `reply` to the request in `c`, which came in at `origin`, as Verso's public URLs start,
 * which links to other pages of a list do too.
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

    if (!("body" in reply)) return c.body(null, reply.status);

    return route.contentType === undefined
        ? c.json(reply.body, reply.status)
        : c.body(JSON.stringify(reply.body), reply.status, { "content-type": route.contentType });
};
