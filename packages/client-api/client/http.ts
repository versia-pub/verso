/**
 * Sending requests to an instance's client API, and reading what it answers.
 * @module
 */
import type { z } from "zod";

/** A query's values. `undefined` and `null` leave a key out, and arrays are sent as `key[]`. */
export type Query = Readonly<
    Record<string, string | number | boolean | readonly string[] | undefined | null>
>;

/** A form's values, for bodies with files. `undefined` and `null` leave a field out. */
export type Form = Readonly<Record<string, string | number | boolean | Blob | undefined | null>>;

/** What every method takes, last. */
export type CallOptions = {
    /** Cancels the request. */
    readonly signal?: AbortSignal;
};

/** How many requests are left before the instance turns them away, and when that resets. */
export type RateLimit = {
    readonly limit: number;
    readonly remaining: number;
    readonly reset: Date;
};

/** What a request sends, beside its method and path. */
export type RequestOptions = CallOptions & {
    readonly query?: Query;
    /** Sent as JSON. */
    readonly json?: unknown;
    /** Sent as `multipart/form-data`. */
    readonly form?: Form;
    /** Sent as `application/x-www-form-urlencoded`, as OAuth's endpoints expect. */
    readonly urlencoded?: Readonly<Record<string, string | undefined>>;
};

/**
 * A response that isn't a success, with the error the instance gave. Instances give
 * `{ "error": "…" }`, with `error_description` when there is more to say, and Verso adds `details`
 * when a request doesn't validate.
 */
export class ApiError extends Error {
    override readonly name = "ApiError";

    constructor(
        readonly status: number,
        readonly error: string,
        readonly description: string | undefined,
        /** The problems with each field, by its path, when the request didn't validate. */
        readonly details: Readonly<Record<string, readonly string[]>> | undefined,
        /** When to try again, on a `429` or `503` that says. */
        readonly retryAfter: Date | undefined,
        readonly rateLimit: RateLimit | undefined,
    ) {
        super(
            description === undefined
                ? `${status}: ${error}`
                : `${status}: ${error}: ${description}`,
        );
    }
}

/** A success whose body isn't what the method gives, as when the URL isn't a Versia instance. */
export class UnexpectedResponse extends Error {
    override readonly name = "UnexpectedResponse";

    constructor(readonly status: number, readonly issues: readonly z.core.$ZodIssue[]) {
        super(`The ${status} response isn't what was expected: ${issues[0]?.message ?? "no body"}`);
    }
}

/**
 * A path with each value put in it escaped, so an id or emoji can't change which route it is.
 * @example path`/api/v1/statuses/${id}/reactions/${emoji}`
 */
export const path = (strings: TemplateStringsArray, ...values: readonly string[]): string =>
    strings.reduce((whole, string, i) => whole + encodeURIComponent(values[i - 1]) + string);

/** The rate limit a response gives in Mastodon's headers, or `undefined` if it gives none. */
const rateLimitOf = (headers: Headers): RateLimit | undefined => {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = new Date(headers.get("x-ratelimit-reset") ?? "");
    if (!headers.has("x-ratelimit-limit") || isNaN(reset.getTime())) return undefined;

    return { limit, remaining, reset };
};

/** When `Retry-After` says to try again, in seconds or as a date. */
const retryAfterOf = (headers: Headers, now: Date): Date | undefined => {
    const value = headers.get("retry-after");
    if (value === null) return undefined;

    const at = /^\d+$/.test(value)
        ? new Date(now.getTime() + Number(value) * 1000)
        : new Date(value);
    return isNaN(at.getTime()) ? undefined : at;
};

/** The error a failed response gives, with its status's name if its body isn't one. */
const errorOf = async (response: Response): Promise<ApiError> => {
    const body = await response.json().catch(() => undefined);
    const error = typeof body?.error === "string" ? body.error : response.statusText;

    return new ApiError(
        response.status,
        error || String(response.status),
        typeof body?.error_description === "string" ? body.error_description : undefined,
        typeof body?.details === "object" ? body.details : undefined,
        retryAfterOf(response.headers, new Date()),
        rateLimitOf(response.headers),
    );
};

/** A body's fields, without those left out. */
const given = <T>(fields: Readonly<Record<string, T | undefined | null>>): [string, T][] =>
    Object.entries(fields).filter((field): field is [string, T] => field[1] != null);

/** Sends requests to one instance, as one user or app, or as nobody. */
export class Http {
    #rateLimit: RateLimit | undefined;

    constructor(
        readonly url: URL,
        readonly token: string | undefined,
        private readonly fetch: typeof globalThis.fetch,
    ) {}

    /** The rate limit the latest response gave. */
    get rateLimit(): RateLimit | undefined {
        return this.#rateLimit;
    }

    /** Sends a request to `to`, a path or a URL on the instance. Throws if it isn't a success. */
    async send(method: string, to: string | URL, options: RequestOptions = {}): Promise<Response> {
        const url = new URL(to, this.url);
        // Pages link to URLs the instance chose; the token must go nowhere else.
        if (url.origin !== this.url.origin) throw new Error(`${url} isn't on ${this.url.origin}`);

        for (const [key, value] of given(options.query ?? {})) {
            if (typeof value !== "object") url.searchParams.set(key, String(value));
            else for (const item of value) url.searchParams.append(`${key}[]`, item);
        }

        const headers = new Headers({ accept: "application/json" });
        if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);

        let body: BodyInit | undefined;
        if (options.json !== undefined) {
            headers.set("content-type", "application/json");
            body = JSON.stringify(options.json);
        } else if (options.form !== undefined) {
            const form = new FormData();
            for (const [key, value] of given(options.form)) {
                form.append(key, value instanceof Blob ? value : String(value));
            }
            body = form;
        } else if (options.urlencoded !== undefined) {
            body = new URLSearchParams(given(options.urlencoded));
        }

        const response = await this.fetch(url, { method, headers, body, signal: options.signal });
        this.#rateLimit = rateLimitOf(response.headers) ?? this.#rateLimit;
        if (!response.ok) throw await errorOf(response);

        return response;
    }

    /** Sends a request, and reads its body as `schema` says it is. */
    async json<S extends z.ZodType>(
        schema: S,
        method: string,
        to: string | URL,
        options?: RequestOptions,
    ): Promise<z.output<S>> {
        const response = await this.send(method, to, options);

        return await parse(schema, response);
    }
}

/** Reads `response`'s body as `schema` says it is. */
export const parse = async <S extends z.ZodType>(
    schema: S,
    response: Response,
): Promise<z.output<S>> => {
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new UnexpectedResponse(response.status, parsed.error.issues);

    return parsed.data;
};
