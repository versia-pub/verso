import type { z } from "zod";
import type { Permission } from "../kernel/permissions.ts";
import type { Scope } from "../kernel/scopes.ts";
import type { Context } from "../kernel/context.ts";
import type { Reply, Responses } from "./responses.ts";

type Schema = z.ZodType;
type Empty = z.ZodType<Record<string, never>>;

/** Who may call a route, by the access token in its `Authorization: Bearer` header. */
export type Auth = {
    /**
     * `user`: a token for a user. `app`: any token, also one an app obtained for itself.
     * `optional`: anyone, but a token sent must be valid.
     */
    readonly require: "user" | "app" | "optional";
    /**
     * The scope the token needs, such as `read:statuses`. Scopes that cover it, like `read`, do
     * too.
     */
    readonly scope?: Scope;
    /**
     * What the caller must be allowed to do, checked after the scope. Users may do what config lets
     * every user, and what their roles allow; anyone else, what it lets anonymous visitors.
     */
    readonly permission?: Permission;
};

/** Who is calling, as their access token says. */
export type Viewer = {
    readonly tokenId: string;
    readonly appId: string;
    /** The user the app acts for, or `null` if the app acts for itself. */
    readonly accountId: string | null;
    readonly scopes: readonly Scope[];
};

/** Who is calling, as a route's handler sees them. */
export type RouteViewer = Viewer & {
    /**
     * What the caller may do: for a user, what config lets every user and their roles allow, and
     * for an app acting for itself, what it lets anonymous visitors. Looked up once, when first
     * requested, and again after {@link RouteViewer.forgetPermissions}.
     */
    readonly permissions: () => Promise<ReadonlySet<Permission>>;
    /** Makes the next {@link RouteViewer.permissions} look them up again, as they changed. */
    readonly forgetPermissions: () => void;
};

/** The viewer a route's handler sees, which its `auth` decides. */
export type ViewerFor<A> = A extends { require: "user" }
    ? RouteViewer & { readonly accountId: string }
    : A extends { require: "app" } ? RouteViewer
    : A extends { require: "optional" } ? RouteViewer | undefined
    // A route whose types were erased could be any of them.
    : A extends Auth ? RouteViewer | undefined
    : undefined;

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
    A extends Auth | undefined,
    R extends Responses,
    S extends true | undefined = true | undefined,
> = {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** In Hono's syntax, such as `/api/v1/accounts/:id`. */
    readonly path: string;
    /** One line for the API documentation. */
    readonly summary: string;
    /** More for the API documentation, such as how Verso differs from Mastodon. */
    readonly description?: string;
    /**
     * Where the route is documented elsewhere, such as Mastodon's documentation for a client API
     * route.
     */
    readonly docs?: string;
    /** The groups the route is listed under in the API documentation, such as `accounts`. */
    readonly tags?: readonly string[];
    /**
     * The media type of the route's JSON bodies, if not `application/json`. Versia's entity
     * endpoints, for one, must respond with `application/vnd.versia+json; charset=utf-8`.
     * @see https://versia.pub/federation/http#http-response-content-type
     */
    readonly contentType?: string;
    /**
     * Handles input it can't read as OAuth does, with 400 `invalid_request`, rather than Mastodon's
     * 422. For the endpoints apps call as OAuth clients, such as `/oauth/token`.
     * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.2
     */
    readonly oauthErrors?: boolean;
    /**
     * How many seconds anyone may cache the route's successful responses, for ones that are the
     * same for everyone, such as pictures. Without it, nothing may cache them.
     */
    readonly maxAge?: number;
    /**
     * Anyone may cache the route's successful responses for a year, and never revalidate them, for
     * files stored under the hash of their bytes, which never change.
     */
    readonly immutable?: true;
    /**
     * What the route's pages may load and run, as a Content-Security-Policy, for a page that needs
     * more than styles of its own, such as a script. Pages can never be framed, whatever it says.
     * @see https://developer.mozilla.org/docs/Web/HTTP/Guides/CSP
     */
    readonly pagePolicy?: string;
    /**
     * `false` exempts the route from rate limits. A bucket counts the route's requests separately
     * from the client's others, with `times` as many allowed, for files a page loads many of at
     * once. Signed routes are limited by the instance that signed, not by client.
     */
    readonly rateLimit?: false | { readonly bucket: string; readonly times: number };
    /** Without it, anyone may call the route, and tokens are ignored. */
    readonly auth?: A;
    /**
     * The access token may also be sent as `Sec-WebSocket-Protocol`, or as the `access_token` query
     * parameter, as Mastodon's streaming API allows, since browsers can't send headers when they
     * open a WebSocket. Only for such routes, since query parameters end up in logs.
     */
    readonly tokenElsewhere?: true;
    /**
     * Only remote instances may call the route: the request must carry a valid Versia signature,
     * which is validated before anything else. The handler gets the signer's domain as `signedBy`,
     * and its responses are signed as this instance.
     * @see https://versia.pub/signatures
     */
    readonly signed?: S;
    readonly params?: P;
    /**
     * Query values are strings, so use `z.coerce` for other types. A key given more than once, or
     * as `key[]`, is an array of strings.
     */
    readonly query?: Q;
    /**
     * A JSON or form body. Only POST, PUT, PATCH and DELETE routes accept one. As in the query,
     * form values are strings (or files), and a key given more than once, or as `key[]`, is an
     * array.
     */
    readonly body?: B;
    /**
     * The body is plain text, `text/plain`, which `body` validates as a string, rather than JSON or
     * a form. A missing body is an empty string.
     */
    readonly textBody?: true;
    /**
     * The largest body the route accepts, in bytes, for one larger than any form, such as a file.
     */
    readonly maxBodyBytes?: number;
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
            viewer: ViewerFor<A>;
            /** The domain of the instance that signed the request, on `signed` routes. */
            signedBy: S extends true ? string : undefined;
            /**
             * The body exactly as it was signed, on `signed` routes, for ones that read it by the
             * protocol's rules rather than through `body`.
             */
            signedBody: S extends true ? Uint8Array<ArrayBuffer> : undefined;
            /** The request's signature, as in `Versia-Signature`, on `signed` routes. */
            signature: S extends true ? string : undefined;
        },
    ) => Promise<Reply<R>>;
};

/** A route with its types erased, so routes of every shape fit in one array. */
export type Route = RouteDefinition<
    Schema,
    Schema,
    Schema,
    Schema,
    Schema,
    Auth | undefined,
    Responses
>;

/** Validates a route's types and erases them. */
export const defineRoute = <
    P extends Schema = Empty,
    Q extends Schema = Empty,
    B extends Schema = Empty,
    C extends Schema = Empty,
    H extends Schema = Empty,
    const A extends Auth | undefined = undefined,
    R extends Responses = Responses,
    const S extends true | undefined = undefined,
>(route: RouteDefinition<P, Q, B, C, H, A, R, S>): Route => route as unknown as Route;
