/**
 * Media such as an image. Remote media is stored by URL and the metadata its instance provided;
 * local media is an upload stored in the file store under its SHA-256.
 */
export type MediaTable = {
    id: string;
    /** The instance the media belongs to, in `instances`, or `null` for the local instance. */
    instance_id: string | null;
    /** Where remote media is hosted. Verso doesn't download it; clients load it from there. */
    url: string | null;
    /** Such as `image/png`. */
    media_type: string;
    /** In bytes. */
    size: number | null;
    /**
     * The SHA-256 of the file in hex, which a local file is stored under. `null` for a local image
     * that couldn't be processed; nothing is stored for it, as it may hold metadata.
     */
    sha256: string | null;
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
    /** When local media was processed, or `null` while it is being processed. */
    processed_at: Date | null;
    /** A smaller WebP preview image of local media: its SHA-256 and size. */
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
};

/** A media attachment on a status, at its position among the status's media, counting from 0. */
export type NoteMediaTable = {
    note_id: string;
    /** Each media row is attached to at most one status. */
    media_id: string;
    position: number;
};
