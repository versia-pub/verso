import type { HtmlEscapedString } from "@hono/hono/utils/html";
import type { ContentfulStatusCode, RedirectStatusCode } from "@hono/hono/utils/http-status";
import type { z } from "zod";
import type { Permission } from "../kernel/permissions.ts";
import type { Scope } from "../kernel/scopes.ts";
import type { Context } from "../kernel/context.ts";

type Schema = z.ZodType;
type Empty = z.ZodType<Record<string, never>>;

/** Declares a response that is an HTML page, for the few that browsers see rather than clients. */
export const Page = { kind: "page" } as const;

/**
 * The type Versia's entity endpoints answer with, for a route's `contentType`.
 * @see https://versia.pub/federation/http#http-response-content-type
 */
export const versiaJson = "application/vnd.versia+json; charset=utf-8";

/** Declares a response that redirects, to the URL in its `Location` header. */
export const Redirect = { kind: "redirect" } as const;

/** Declares a response that is a file, such as a picture, of this media type. */
export const Binary = <T extends string>(
    type: T,
): { readonly kind: "binary"; readonly type: T } => ({
    kind: "binary",
    type,
});
type Binary = ReturnType<typeof Binary>;

/** A JSON body's schema, or a page, a redirect or a file, for each status. */
export type Responses = Partial<
    Record<ContentfulStatusCode, Schema | typeof Page | typeof Redirect | Binary>
>;

/** HTML from Hono's `html` template, which escapes every value put into it. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

type ReplyFor<S, R> = R extends typeof Page ? { status: S; page: Html }
    : R extends typeof Redirect ? { status: S & RedirectStatusCode; location: string }
    : R extends Binary ? { status: S; file: Uint8Array }
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

/** Who may call a route, by the access token in its `Authorization: Bearer` header. */
export type Auth = {
    /**
     * `user`: a token for a user. `app`: any token, also one an app got for itself. `optional`:
     * anyone, but a token sent must be valid.
     */
    readonly require: "user" | "app" | "optional";
    /**
     * The scope the token needs, such as `read:statuses`. Scopes that cover it, like `read`, do
     * too.
     */
    readonly scope?: Scope;
    /**
     * What the caller must be allowed to do, checked after the scope. Users may do what config
     * lets every user, and what their roles allow; anyone else, what it lets anonymous visitors.
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
     * What the caller may do: a user, what config lets every user and their roles allow, and an
     * app acting for itself, what it lets anonymous visitors. Looked up once, when first asked.
     */
    readonly permissions: () => Promise<ReadonlySet<Permission>>;
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
> = {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** In Hono's syntax, such as `/api/v1/accounts/:id`. */
    readonly path: string;
    /** One line for the API documentation. */
    readonly summary: string;
    /** The groups the route is listed under in the API documentation, such as `accounts`. */
    readonly tags?: readonly string[];
    /**
     * The media type of the route's JSON bodies, if not `application/json`. Versia's entity
     * endpoints, for one, must answer `application/vnd.versia+json; charset=utf-8`.
     * @see https://versia.pub/federation/http#http-response-content-type
     */
    readonly contentType?: string;
    /**
     * Answers input it can't read as OAuth does, with 400 `invalid_request`, rather than Mastodon's
     * 422. For the endpoints apps call as OAuth clients, such as `/oauth/token`.
     * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.2
     */
    readonly oauthErrors?: boolean;
    /**
     * How many seconds anyone may cache the route's successful replies, for ones that are the same
     * for everyone, such as pictures. Without it, nothing may cache them.
     */
    readonly maxAge?: number;
    /**
     * What the route's pages may load and run, as a Content-Security-Policy, for a page that needs
     * more than styles of its own, such as a script. Pages can never be framed, whatever it says.
     * @see https://developer.mozilla.org/docs/Web/HTTP/Guides/CSP
     */
    readonly pagePolicy?: string;
    /** `false` exempts the route from rate limits, for files a page loads many of at once. */
    readonly rateLimit?: false;
    /** Without it, anyone may call the route, and tokens are ignored. */
    readonly auth?: A;
    /**
     * Only other instances may call the route: the request must carry a valid Versia signature,
     * which is checked before anything else. The handler gets the signer's domain as `signedBy`,
     * and its replies are signed as this instance.
     * @see https://versia.pub/signatures
     */
    readonly signed?: true;
    readonly params?: P;
    /**
     * Query values are strings, so use `z.coerce` for other types. A key given more than once, or
     * as `key[]`, is an array of strings.
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
            viewer: ViewerFor<A>;
            /** The domain of the instance that signed the request, on `signed` routes. */
            signedBy: string | undefined;
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

/** Checks a route's types and erases them. */
export const defineRoute = <
    P extends Schema = Empty,
    Q extends Schema = Empty,
    B extends Schema = Empty,
    C extends Schema = Empty,
    H extends Schema = Empty,
    const A extends Auth | undefined = undefined,
    R extends Responses = Responses,
>(route: RouteDefinition<P, Q, B, C, H, A, R>): Route => route as unknown as Route;
