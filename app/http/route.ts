import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import type { z } from "zod";
import type { Context } from "../kernel/context.ts";

type Schema = z.ZodType;
type Empty = z.ZodType<Record<string, never>>;
type Responses = Partial<Record<ContentfulStatusCode, Schema>>;

/** One of the responses a route declares, with a body its schema accepts. */
export type Reply<R extends Responses> = {
    [S in keyof R & ContentfulStatusCode]: { status: S; body: z.input<NonNullable<R[S]>> };
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
    readonly responses: R;
    readonly handler: (
        ctx: Context,
        input: { params: z.output<P>; query: z.output<Q>; body: z.output<B> },
    ) => Promise<Reply<R>>;
};

/** A route with its types erased, so routes of every shape fit in one array. */
export type Route = RouteDefinition<Schema, Schema, Schema, Responses>;

/** Checks a route's types and erases them. */
export const defineRoute = <
    P extends Schema = Empty,
    Q extends Schema = Empty,
    B extends Schema = Empty,
    R extends Responses = Responses,
>(route: RouteDefinition<P, Q, B, R>): Route => route as unknown as Route;
