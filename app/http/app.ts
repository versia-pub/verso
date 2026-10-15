import { type Context as HonoContext, Hono } from "@hono/hono";
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
import type { Route } from "./route.ts";

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

/** Throws when a reply doesn't match the schema its route declares for its status. */
const checkReply = (route: Route, reply: { status: number; body: unknown }) => {
    const schema = route.responses[reply.status as keyof Route["responses"]];
    const result = schema?.safeParse(reply.body);
    if (result?.success) return;

    const problem = result ? z.prettifyError(result.error) : "the status isn't declared";
    throw new Error(
        `${route.method} ${route.path} replied ${reply.status} with an undeclared shape: ${problem}`,
    );
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

    // For load balancers and orchestrators, not clients, so it stays plain text.
    app.get("/health/live", (c) => c.text("ok"));

    for (const route of routes) {
        app.on(route.method, route.path, async (c) => {
            const input = validate({
                params: { schema: route.params, value: c.req.param() },
                query: { schema: route.query, value: queryOf(c) },
                body: { schema: route.body, value: await bodyOf(c, route) },
            });

            const reply = await route.handler(ctx, input);
            if (options.checkResponses) checkReply(route, reply);

            return c.json(reply.body, reply.status);
        });
    }

    app.notFound(() => {
        throw new NotFound();
    });

    app.onError((error, c) => {
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
