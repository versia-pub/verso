/**
 * Reading the pages that statuses link to, and the images on them, once fetched.
 * @module
 */
import type { Fetched } from "../kernel/web_fetch.ts";

/** Pages are read up to this many bytes, and the rest is ignored. */
export const pageBytes = 1024 * 1024;

/** An image larger than this is not used. */
export const imageBytes = 8 * 1024 * 1024;

/** The charset a `Content-Type` header names, if it does. */
const headerCharset = (contentType: string | null) =>
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];

/** The charset a page names in its first bytes, with `<meta charset>` or `http-equiv`. */
const metaCharset = (body: Uint8Array) => {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
    return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
};

/**
 * `fetched`'s body as text, in the charset the header or the page names, or else UTF-8. Mastodon
 * also guesses the charset from the bytes, which Verso doesn't.
 */
export const decodePage = (fetched: Fetched): string => {
    for (
        const label of [
            headerCharset(fetched.headers.get("content-type")),
            metaCharset(fetched.body),
        ]
    ) {
        if (!label) continue;

        try {
            return new TextDecoder(label).decode(fetched.body);
        } catch {
            // A charset that isn't known.
        }
    }

    return new TextDecoder().decode(fetched.body);
};
