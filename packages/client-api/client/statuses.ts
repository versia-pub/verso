import type { Visibility } from "../account.ts";
import { Status, StatusSource } from "../status.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** How a status's text is written. Plain text has its links, mentions and hashtags linked. */
export type ContentType = "text/plain" | "text/markdown";

/** A new status. It needs text, media, or both. */
export type StatusDraft = {
    readonly status?: string;
    /** Uploads to attach, in order. */
    readonly media_ids?: readonly string[];
    /** Defaults to plain text. */
    readonly content_type?: ContentType;
    /** A content warning, shown in place of the text until the reader opens it. */
    readonly spoiler_text?: string;
    /** Whether the media is hidden until the reader opens it. */
    readonly sensitive?: boolean;
    /** An ISO 639-1 code, such as `en`, or the author's default if omitted. */
    readonly language?: string;
    /** Defaults to the author's. */
    readonly visibility?: Visibility;
    readonly in_reply_to_id?: string;
};

/** A change to a status. What is omitted stays as it was, but the text must always be given. */
export type StatusChanges = {
    readonly status: string;
    /** Replaces the media. */
    readonly media_ids?: readonly string[];
    /** Changes the media's descriptions or focus points, as `media.update` does. */
    readonly media_attributes?: readonly {
        readonly id: string;
        readonly description?: string;
        /** Two numbers from -1 to 1, as `x,y`. */
        readonly focus?: string;
    }[];
    readonly content_type?: ContentType;
    readonly spoiler_text?: string;
    readonly sensitive?: boolean;
    readonly language?: string;
};

/** Posting, viewing, editing and deleting statuses. */
export class StatusMethods {
    constructor(private readonly http: Http) {}

    /**
     * A status, if the viewer may see it.
     * @see https://docs.joinmastodon.org/methods/statuses/#get
     */
    get(id: string, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "GET", path`/api/v1/statuses/${id}`, options);
    }

    /**
     * Posts a status.
     * @see https://docs.joinmastodon.org/methods/statuses/#create
     */
    post(draft: StatusDraft, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "POST", "/api/v1/statuses", { ...options, json: draft });
    }

    /**
     * Edits one of the viewer's statuses.
     * @see https://docs.joinmastodon.org/methods/statuses/#edit
     */
    edit(id: string, changes: StatusChanges, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "PUT", path`/api/v1/statuses/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * Deletes one of the viewer's statuses or shares. Gives it back with its `text`, so it can be
     * posted again with changes.
     * @see https://docs.joinmastodon.org/methods/statuses/#delete
     */
    delete(id: string, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "DELETE", path`/api/v1/statuses/${id}`, options);
    }

    /**
     * A status as its author wrote it, for editing it.
     * @see https://docs.joinmastodon.org/methods/statuses/#source
     */
    source(id: string, options?: CallOptions): Promise<StatusSource> {
        return this.http.json(StatusSource, "GET", path`/api/v1/statuses/${id}/source`, options);
    }
}
