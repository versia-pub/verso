/**
 * A file, such as a picture: a remote one, by its URL and what its instance said about it. Local
 * uploads join it with the media module, kept in storage and served by Verso.
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
    /** The SHA-256 of the file, in hex. */
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
};
