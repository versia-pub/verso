import type { HtmlEscapedString } from "@hono/hono/utils/html";
import type { ContentfulStatusCode, RedirectStatusCode } from "@hono/hono/utils/http-status";
import type { z } from "zod";
import type { Context } from "../kernel/context.ts";

type Schema = z.ZodType;
type Empty = z.ZodType<Record<string, never>>;

/** Declares a response that is an HTML page, for the few that browsers see rather than clients. */
export const Page = { kind: "page" } as const;

/** Declares a response that redirects, to the URL in its `Location` header. */
export const Redirect = { kind: "redirect" } as const;

/** A JSON body's schema, or a page or a redirect, for each status. */
export type Responses = Partial<
    Record<ContentfulStatusCode, Schema | typeof Page | typeof Redirect>
>;

/** HTML from Hono's `html` template, which escapes every value put into it. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

type ReplyFor<S, R> = R extends typeof Page ? { status: S; page: Html }
    : R extends typeof Redirect ? { status: S & RedirectStatusCode; location: string }
    : R extends Schema ? { status: S; body: z.input<R> }
    : never;

/**
 * Cookies a reply sets, by name, or deletes with `null`. They last until the browser closes, and
 * scripts and other sites can't read them.
 */
export type CookieChanges = Readonly<Record<string, string | null>>;

/** One of the responses a route declares: a body its schema accepts, a page, or a redirect. */
export type Reply<R extends Responses> = {
    [S in keyof R & ContentfulStatusCode]: ReplyFor<S, NonNullable<R[S]>> & {
        cookies?: CookieChanges;
    };
}[keyof R & ContentfulStatusCode];

/**
 * One endpoint, declared as data. Input is validated against the schemas before the handler runs,
 * so the handler only sees valid input. The handler calls services and never touches the database
 * or the network itself.
 */
export type RouteDefinition<
    P extends Schema,
    Q extends Schema,
    B extends Schema,
    C extends Schema,
    H extends Schema,
    R extends Responses,
> = {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** In Hono's syntax, such as `/api/v1/accounts/:id`. */
    readonly path: string;
    /** One line for the API documentation. */
    readonly summary: string;
    readonly params?: P;
    /**
     * Query values are strings, so use `z.coerce` for other types. A key given more than once is
     * an array of strings.
     */
    readonly query?: Q;
    /**
     * A JSON or form body. Only POST, PUT, PATCH and DELETE routes take one. As in the query, form
     * values are strings (or files), and a key given more than once, or as `key[]`, is an array.
     */
    readonly body?: B;
    /** The cookies the route reads, which are strings. Only the ones Verso set are seen. */
    readonly cookies?: C;
    /** The request headers the route reads, by lowercase name. */
    readonly headers?: H;
    readonly responses: R;
    readonly handler: (
        ctx: Context,
        input: {
            params: z.output<P>;
            query: z.output<Q>;
            body: z.output<B>;
            cookies: z.output<C>;
            headers: z.output<H>;
        },
    ) => Promise<Reply<R>>;
};

/** A route with its types erased, so routes of every shape fit in one array. */
export type Route = RouteDefinition<Schema, Schema, Schema, Schema, Schema, Responses>;

/** Checks a route's types and erases them. */
export const defineRoute = <
    P extends Schema = Empty,
    Q extends Schema = Empty,
    B extends Schema = Empty,
    C extends Schema = Empty,
    H extends Schema = Empty,
    R extends Responses = Responses,
>(route: RouteDefinition<P, Q, B, C, H, R>): Route => route as unknown as Route;
