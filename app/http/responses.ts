/**
 * What routes declare they respond with, for each status, and the replies their handlers return
 * for each kind.
 * @module
 */
import type { HtmlEscapedString } from "@hono/hono/utils/html";
import type { ContentfulStatusCode, RedirectStatusCode } from "@hono/hono/utils/http-status";
import type { z } from "zod";

type Schema = z.ZodType;

/** Declares a response that is an HTML page, for the few that browsers see rather than clients. */
export const Page = { kind: "page" } as const;

/**
 * The type Versia's entity endpoints respond with, for a route's `contentType`.
 * @see https://versia.pub/federation/http#http-response-content-type
 */
export const versiaJson = "application/vnd.versia+json; charset=utf-8";

/** Declares a response that redirects, to the URL in its `Location` header. */
export const Redirect = { kind: "redirect" } as const;

/** Declares a response with no body, such as a 202 for work that is done later. */
export const NoBody = { kind: "none" } as const;

/** Declares a response that turns the connection into a WebSocket, as status 101. */
export const Upgrade = { kind: "upgrade" } as const;

/** Declares a response that is a file, such as a picture, of this media type. */
export const Binary = <T extends string>(
    type: T,
): { readonly kind: "binary"; readonly type: T } => ({
    kind: "binary",
    type,
});
type Binary = ReturnType<typeof Binary>;

/**
 * Declares a response that is a page of a list of `item`, newest first, with the cursors of the
 * pages around it in its `Link` header.
 */
export const Paged = <T extends Schema>(item: T): { readonly kind: "paged"; readonly item: T } => ({
    kind: "paged",
    item,
});
type Paged = ReturnType<typeof Paged>;

/**
 * Declares a response that is a page of a list in a shape of its own, `body`, such as notifications
 * in groups, with the cursors of the pages around it in its `Link` header.
 */
export const Linked = <T extends Schema>(
    body: T,
): { readonly kind: "linked"; readonly body: T } => ({
    kind: "linked",
    body,
});
type Linked = ReturnType<typeof Linked>;

/** Where the pages around a page of a list start, if there are any. */
export type Cursors = { readonly newer?: string; readonly older?: string };

/** A status a route may respond with: one with a body, or 101 for a WebSocket. */
type Status = ContentfulStatusCode | 101;

/**
 * A JSON body's schema, or a page, a redirect, a file, a list, a list in a shape of its own,
 * nothing or a WebSocket, for each status.
 */
export type Responses = Partial<
    Record<
        Status,
        | Schema
        | typeof Page
        | typeof Redirect
        | Binary
        | Paged
        | Linked
        | typeof NoBody
        | typeof Upgrade
    >
>;

/** HTML from Hono's `html` template, which escapes every value put into it. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

type ReplyFor<S, R> = R extends typeof Page ? { status: S; page: Html }
    : R extends typeof Redirect ? { status: S & RedirectStatusCode; location: string }
    : R extends Binary ? {
            status: S;
            file: Uint8Array | ReadableStream<Uint8Array>;
            /** The file's media type, if not the one declared. */
            type?: string;
            /** Has browsers download the file rather than display it. */
            download?: true;
        }
    : R extends Paged ? { status: S; body: z.input<R["item"]>[]; cursors: Cursors }
    : R extends Linked ? { status: S; body: z.input<R["body"]>; cursors: Cursors }
    : R extends typeof NoBody ? { status: S }
    : R extends typeof Upgrade ? {
            status: S;
            /** Called with the WebSocket once the connection is one. */
            socket: (socket: WebSocket) => void;
            /** The subprotocol to accept, of those the client asked for. */
            protocol?: string;
        }
    : R extends Schema ? { status: S; body: z.input<R> }
    : never;

/**
 * Cookies a response sets, by name, or deletes with `null`. They last until the browser closes, and
 * scripts and other sites can't read them.
 */
export type CookieChanges = Readonly<Record<string, string | null>>;

/** One of the responses a route declares: a body its schema accepts, a page, or a redirect. */
export type Reply<R extends Responses> = {
    [S in keyof R & Status]: ReplyFor<S, NonNullable<R[S]>> & {
        cookies?: CookieChanges;
    };
}[keyof R & Status];
