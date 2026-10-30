import { MediaAttachment } from "../media_attachment.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** A file to attach to a status. */
export type Upload = {
    readonly file: Blob;
    /** Alt text, for those who can't see it. */
    readonly description?: string;
    /** Where to keep in view when it is cropped: two numbers from -1 to 1, as `x,y`. */
    readonly focus?: string;
};

/** Uploading files to attach to statuses. */
export class MediaMethods {
    constructor(private readonly http: Http) {}

    /**
     * Uploads a file to attach to a status. Pictures are processed after this returns, and until
     * they are, the attachment's `url` is `null`.
     * @see https://docs.joinmastodon.org/methods/media/#v2
     */
    upload(upload: Upload, options?: CallOptions): Promise<MediaAttachment> {
        return this.http.json(MediaAttachment, "POST", "/api/v2/media", {
            ...options,
            form: upload,
        });
    }

    /**
     * Changes the description or focus point of an upload, until it is attached to a status.
     * @see https://docs.joinmastodon.org/methods/media/#update
     */
    update(
        id: string,
        changes: Omit<Upload, "file">,
        options?: CallOptions,
    ): Promise<MediaAttachment> {
        return this.http.json(MediaAttachment, "PUT", path`/api/v1/media/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * One of the viewer's uploads. Its `url` is `null` until it is processed.
     * @see https://docs.joinmastodon.org/methods/media/#get
     */
    get(id: string, options?: CallOptions): Promise<MediaAttachment> {
        return this.http.json(MediaAttachment, "GET", path`/api/v1/media/${id}`, options);
    }
}
