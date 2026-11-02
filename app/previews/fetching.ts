/**
 * Fetching the pages that statuses link to, and the images on them. Every hop of a redirect is a
 * new request through the context's transport, so each is checked as the first was.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { timeoutSignal, userAgent } from "../kernel/transport.ts";

/** How many redirects are followed. */
const maxRedirects = 5;

/** How long fetching a page or an image may take in all, as Mastodon allows. */
const totalMs = 30_000;

/** Pages are read up to this many bytes, and the rest is ignored. */
export const pageBytes = 1024 * 1024;

/** An image larger than this is not used. */
export const imageBytes = 8 * 1024 * 1024;

/** What a fetch gives back: the address it ended at, the response's headers, and its body. */
export type Fetched = {
    readonly url: URL;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
    /** Whether the body was cut off at the limit. */
    readonly truncated: boolean;
};

/** Reads up to `limit` bytes of `stream`, and stops there. */
const readLimited = async (stream: ReadableStream<Uint8Array> | null, limit: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;

    if (stream) {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const room = limit - size;
                if (value.length > room) {
                    chunks.push(value.subarray(0, room));
                    size = limit;
                    truncated = true;
                    break;
                }

                chunks.push(value);
                size += value.length;
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
    }

    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
    }

    return { body, truncated };
};

/**
 * Fetches `url` and follows redirects to other web addresses, then reads up to `limit` bytes of the
 * body. Resolves with `undefined` if it ends in anything but a 200, runs out of redirects or time,
 * can't be reached, or isn't of a type `accept` approves. The fetch is of public addresses only,
 * as far as the context's transport guarantees.
 */
export const fetchLimited = async (
    ctx: Context,
    url: URL,
    options: {
        readonly accept: string;
        /** Whether the response's `Content-Type` is one to read. */
        readonly approves: (contentType: string) => boolean;
        readonly limit: number;
    },
): Promise<Fetched | undefined> => {
    const signal = timeoutSignal(totalMs, ctx.signal);

    try {
        let at = url;
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
            const response = await ctx.transport(
                new Request(at, {
                    headers: {
                        "Accept": options.accept,
                        "User-Agent": `${userAgent(ctx.urls.origin)} Bot`,
                    },
                    redirect: "manual",
                    signal,
                }),
            );

            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel();
                const next = new URL(location, at);
                if (!/^https?:$/.test(next.protocol)) return undefined;

                at = next;
                continue;
            }

            const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
            if (response.status !== 200 || !type || !options.approves(type)) {
                await response.body?.cancel();
                return undefined;
            }

            const { body, truncated } = await readLimited(response.body, options.limit);
            return { url: at, headers: response.headers, body, truncated };
        }
    } catch {
        // A server that can't be reached, or that isn't a public one, has no preview.
    }

    return undefined;
};

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
