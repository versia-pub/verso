import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";

/**
 * An error a request ends in, shown to the client in Mastodon's shape:
 * `{ "error": ..., "error_description": ... }`. Anything else thrown is a 500.
 */
export class HttpError extends Error {
    constructor(
        readonly status: ContentfulStatusCode,
        message: string,
        readonly description?: string,
    ) {
        super(message);
    }

    /** The response body. */
    toJSON(): Record<string, unknown> {
        return { error: this.message, error_description: this.description };
    }
}

export class BadRequest extends HttpError {
    constructor(description?: string) {
        super(400, "Bad request", description);
    }
}

export class NotFound extends HttpError {
    constructor(description?: string) {
        super(404, "Record not found", description);
    }
}

export class UnsupportedMediaType extends HttpError {
    constructor(description?: string) {
        super(415, "Unsupported media type", description);
    }
}

/** Input that doesn't match a route's schemas. `details` lists the problems by field path. */
export class ValidationFailed extends HttpError {
    constructor(readonly details: Record<string, string[]>) {
        super(422, "Validation failed");
    }

    override toJSON(): Record<string, unknown> {
        return { ...super.toJSON(), details: this.details };
    }
}
