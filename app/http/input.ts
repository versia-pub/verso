/**
 * A request's input, read from its path, query, body, cookies and headers, and validated against
 * the route's schemas.
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import { getCookie } from "@hono/hono/cookie";
import qs from "qs";
import { z } from "zod";
import { BadRequest, HttpError, UnsupportedMediaType, ValidationFailed } from "./errors.ts";
import type { Route } from "./route.ts";

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
 * The query's values. A key given more than once is an array, and so is a Rails-style `key[]`, read
 * as `key`, even when given once.
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
 * Verso's cookies, without their `__Host-` prefix. Browsers only accept such cookies from this host
 * over HTTPS, so a subdomain or an insecure page can't plant one.
 */
const cookiesOf = (c: HonoContext) =>
    Object.fromEntries(
        Object.entries(getCookie(c))
            .filter(([name]) => name.startsWith("__Host-"))
            .map(([name, value]) => [name.slice("__Host-".length), value]),
    );

/**
 * A form's fields, with Rails-style names read as JSON would have them: `key[]` as an array, and
 * `a[b]` as `b` in the object `a`. Files need plain names, such as `avatar`, as Mastodon's have.
 * @see https://github.com/ljharb/qs#parsing-objects
 */
const formOf = async (c: HonoContext) => {
    const text = new URLSearchParams();
    const files = new Map<string, File>();

    for (const [name, value] of await c.req.formData()) {
        if (typeof value === "string") {
            text.append(name, value);
        } else if (/^\w+$/.test(name) && !files.has(name)) {
            files.set(name, value);
        } else {
            throw new BadRequest(`A file must have a plain name, used once, unlike "${name}"`);
        }
    }

    // Names nested deeper than five are rejected, rather than read as one long key.
    return { ...qs.parse(text.toString(), { strictDepth: true }), ...Object.fromEntries(files) };
};

/**
 * Mastodon clients send JSON or forms, so every route accepts both, except those that take plain
 * text. They send actions such as follows with no body at all, which Mastodon reads as an empty
 * one. Deno's server gives those an empty body, with no type.
 */
const bodyOf = async (c: HonoContext, route: Route) => {
    const type = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
    if (route.body && route.textBody) {
        const text = c.req.raw.body === null ? "" : await c.req.text();
        if (text !== "" && type !== "text/plain") {
            throw new UnsupportedMediaType("The body must be plain text");
        }
        return text;
    }

    if (!route.body || c.req.raw.body === null) return {};
    if (type === undefined && await c.req.text() === "") return {};
    const forms = ["application/x-www-form-urlencoded", "multipart/form-data"];

    if (type !== "application/json" && !forms.includes(type ?? "")) {
        throw new UnsupportedMediaType("The body must be JSON or a form");
    }

    try {
        if (type !== "application/json") return await formOf(c);

        const text = await c.req.text();
        return text === "" ? {} : JSON.parse(text);
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new BadRequest("The body isn't valid JSON or form data");
    }
};

/** The parts of a request a route reads. */
type Part = "params" | "query" | "body" | "cookies" | "headers";

/** The route's validated input, or the reason it isn't valid. */
export const inputOf = async (c: HonoContext, route: Route): Promise<Record<Part, unknown>> =>
    validate({
        params: { schema: route.params, value: c.req.param() },
        query: { schema: route.query, value: queryOf(c) },
        body: { schema: route.body, value: await bodyOf(c, route) },
        cookies: { schema: route.cookies, value: cookiesOf(c) },
        headers: { schema: route.headers, value: c.req.header() },
    });

/** An input error as OAuth's `invalid_request`, naming what was wrong. */
export const asOAuthError = (error: unknown): unknown => {
    if (error instanceof ValidationFailed) {
        const fields = Object.keys(error.details).join(", ");
        return new HttpError(400, "invalid_request", `These are invalid: ${fields}.`);
    }

    return error instanceof HttpError
        ? new HttpError(400, "invalid_request", error.description ?? error.message)
        : error;
};
