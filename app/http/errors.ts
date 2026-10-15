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

/** No valid access token, where a route needs one. */
export class Unauthorized extends HttpError {
    constructor() {
        super(401, "The access token is invalid");
    }
}

/** The access token lacks the scope a route needs. */
export class Forbidden extends HttpError {
    constructor() {
        super(403, "This action is outside the authorized scopes");
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

/** An app's own token, where a route acts for a user. Mastodon answers 422 here. */
export class UserRequired extends HttpError {
    constructor() {
        super(422, "This method requires an authenticated user");
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
