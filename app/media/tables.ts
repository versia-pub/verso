/**
 * Media, like an image. Remote media is stored by URL and the metadata its instance provided, and
 * a copy of its file is cached in the file store; local media is an upload stored in the file store
 * under its SHA-256.
 */
export type MediaTable = {
    id: string;
    /** The instance the media belongs to, in `instances`, or `null` for the local instance. */
    instance_id: string | null;
    /** Where remote media is hosted. */
    url: string | null;
    /** The media type, like `image/png`. For remote media, the type its instance gave. */
    media_type: string;
    /** In bytes. */
    size: number | null;
    /**
     * The SHA-256 of the file in hex, which it is stored under. `null` for a local image that
     * couldn't be processed, since nothing is stored for one, and for remote media that isn't
     * cached.
     */
    sha256: string | null;
    /** The SHA-256 in hex that the remote instance gave for its media's file, if it gave one. */
    remote_sha256: string | null;
    /** The type the cached file of remote media is served as. */
    cached_type: string | null;
    /** In pixels, for pictures and videos. */
    width: number | null;
    height: number | null;
    /**
     * A tiny preview, displayed while the media loads.
     * @see https://evanw.github.io/thumbhash/
     */
    thumbhash: string | null;
    /** Alt text. */
    description: string | null;
    created_at: Date;
    /** The account that uploaded local media. */
    account_id: string | null;
    /**
     * The SHA-256 of the original upload, which is stored until processing finishes. An image is
     * processed into another file without its metadata; any other file is stored as uploaded.
     */
    upload_sha256: string | null;
    /**
     * When local media was processed, or `null` while it is being processed. When remote media was
     * cached, or `null` until it is; if caching failed, `sha256` is `null`.
     */
    processed_at: Date | null;
    /** A smaller WebP preview image: its SHA-256 and size. */
    preview_sha256: string | null;
    preview_width: number | null;
    preview_height: number | null;
    /**
     * A second kind of tiny preview, which Mastodon clients display.
     * @see https://blurha.sh/
     */
    blurhash: string | null;
    /** The point an image's thumbnails are cropped around, from -1 to 1 on each axis. */
    focus_x: number | null;
    focus_y: number | null;
    /**
     * The box a local image was scaled down to fit in, like for an avatar, or `null` for one
     * only scaled down to the pixel limit.
     */
    fit_width: number | null;
    fit_height: number | null;
};

/** A media attachment on a status, at its position among the status's media, counting from 0. */
export type NoteMediaTable = {
    note_id: string;
    /** Each media row is attached to at most one status. */
    media_id: string;
    position: number;
};

/**
 * Media reserved for a scheduled status, at its position among its media, counting from 0, until it
 * is posted with them attached.
 */
export type ScheduledNoteMediaTable = {
    scheduled_note_id: string;
    /** Each media row is reserved for at most one scheduled status. */
    media_id: string;
    position: number;
};
