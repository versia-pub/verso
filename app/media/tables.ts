/**
 * A file, such as a picture: a remote one, by its URL and what its instance said about it, or one
 * uploaded here, kept in the file store under its SHA-256.
 */
export type MediaTable = {
    id: string;
    /** The instance the file is on, in `instances`, or `null` for this one. */
    instance_id: string | null;
    /** Where a remote file is. Verso doesn't download it, so clients load it from there. */
    url: string | null;
    /** Such as `image/png`. */
    media_type: string;
    /** In bytes. */
    size: number | null;
    /** The SHA-256 of the file, in hex, which a local one is kept under. */
    sha256: string | null;
    /** In pixels, for pictures and videos. */
    width: number | null;
    height: number | null;
    /**
     * A tiny preview, shown while the file loads.
     * @see https://evanw.github.io/thumbhash/
     */
    thumbhash: string | null;
    /** Alt text. */
    description: string | null;
    created_at: Date;
    /** Who uploaded a local file. */
    account_id: string | null;
    /**
     * The SHA-256 of what was uploaded, which is kept until it has been processed. A picture is
     * processed into another file, without its metadata; anything else is kept as it was.
     */
    upload_sha256: string | null;
    /** When a local file was processed, or `null` while it is being processed. */
    processed_at: Date | null;
    /** A smaller picture of a local one, in WebP: its SHA-256 and its size. */
    preview_sha256: string | null;
    preview_width: number | null;
    preview_height: number | null;
    /**
     * Another kind of tiny preview, which Mastodon's clients show.
     * @see https://blurha.sh/
     */
    blurhash: string | null;
    /** The point a picture's thumbnails are cropped around, from -1 to 1 on each axis. */
    focus_x: number | null;
    focus_y: number | null;
};
